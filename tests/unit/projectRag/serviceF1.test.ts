import { mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createProjectRagService } from "../../../src/projectRag/service.js";
import { githubRepoSource } from "../../../src/projectRag/sources/githubRepo.js";
import type { ProjectRagConfig } from "../../../src/projectRag/types.js";

const REPO = "torinmb/mediapipe-touchdesigner";
const META_URL = `https://api.github.com/repos/${REPO}`;
const LICENSE_URL = `${META_URL}/license`;
const README_URL = `${META_URL}/readme`;
const CONTENTS_URL = `${META_URL}/contents/`;
const RAW_TOX = `https://raw.githubusercontent.com/${REPO}/main/MediaPipe.tox`;

const TOX_BYTES = new Uint8Array(Buffer.from("FAKE_TOX_BYTES_FOR_TESTING_ONLY", "utf8"));

const server = setupServer(
  http.get(META_URL, () =>
    HttpResponse.json({
      full_name: REPO,
      html_url: `https://github.com/${REPO}`,
      description: "MediaPipe wrappers for TouchDesigner",
      default_branch: "main",
      topics: ["touchdesigner", "mediapipe", "hand-tracking"],
      owner: { login: "torinmb" },
    }),
  ),
  http.get(LICENSE_URL, () => HttpResponse.json({ path: "LICENSE", license: { spdx_id: "MIT" } })),
  http.get(README_URL, () =>
    HttpResponse.text(
      "# MediaPipe TouchDesigner\n\nReal-time MediaPipe (hand, face, pose) wrapped as a .tox.",
    ),
  ),
  http.get(CONTENTS_URL, () =>
    HttpResponse.json([
      {
        name: "MediaPipe.tox",
        path: "MediaPipe.tox",
        type: "file",
        download_url: RAW_TOX,
      },
    ]),
  ),
  http.get(RAW_TOX, () => HttpResponse.arrayBuffer(TOX_BYTES.buffer)),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function makeConfig(
  dataDir: string,
  allowlist: ProjectRagConfig["licenseAllowlist"],
): ProjectRagConfig {
  return {
    enabled: true,
    dataDir,
    ollamaUrl: "http://127.0.0.1:11434",
    embedModel: "nomic-embed-text",
    licenseAllowlist: allowlist,
    embedBatch: 64,
    backend: "jsonl",
    bridgeAnalysis: false,
    bridgePort: 9981,
    analyzeTimeoutMs: 30000,
    scoreWeights: { technical: 0.45, license: 0.25, freshness: 0.15, reliability: 0.15 },
  };
}

let DIR: string;
beforeEach(() => {
  DIR = join(tmpdir(), `prag-svc-f1-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(DIR, { recursive: true });
});
afterEach(() => rmSync(DIR, { recursive: true, force: true }));

/**
 * Deterministic mock embedder: maps an input string to a 4-dim vector keyed by
 * which "topic" tokens it contains. Mediapipe-ish queries land close to the
 * card's vector under cosine similarity.
 */
const MOCK_EMBEDDINGS = {
  async embed(inputs: string[], _model: string): Promise<number[][]> {
    return inputs.map((text) => {
      const lower = text.toLowerCase();
      const vec: number[] = new Array<number>(4).fill(0);
      if (lower.includes("mediapipe") || lower.includes("hand")) vec[0] = 1;
      if (lower.includes("audio") || lower.includes("fft")) vec[1] = 1;
      if (lower.includes("feedback")) vec[2] = 1;
      if (lower.includes("touchdesigner") || lower.includes("tox")) vec[3] = 1;
      // Ensure non-zero vector so cosine is defined.
      const allZero = vec.reduce((a, b) => a + b, 0) === 0;
      if (allZero) vec[3] = 1;
      const norm = Math.sqrt(vec.reduce((a, b) => a + b * b, 0));
      return vec.map((v) => v / norm);
    });
  },
};

describe("projectRag service — F1 sync→index→search end-to-end", () => {
  it("MIT seed: syncs 1 card, downloads binary, indexes and search returns it ranked high", async () => {
    const config = makeConfig(DIR, ["CC0", "PublicDomain", "MIT", "Apache-2.0"]);
    const svc = createProjectRagService({
      config,
      sources: [githubRepoSource([{ owner: "torinmb", repo: "mediapipe-touchdesigner" }])],
      embeddings: MOCK_EMBEDDINGS,
    });

    const syncReport = await svc.sync({});
    expect(syncReport.added).toBe(1);
    expect(syncReport.binariesStored).toBe(1);
    expect(syncReport.skippedNoLicense).toBe(0);
    expect(syncReport.perSource["github-repo"]).toBe(1);

    // Card written to disk with MIT + provenance.
    const cardFiles = statSync(join(DIR, "cards"));
    expect(cardFiles.isDirectory()).toBe(true);
    const binaryFiles = statSync(join(DIR, "binaries"));
    expect(binaryFiles.isDirectory()).toBe(true);

    // Index.
    const indexReport = await svc.index();
    expect(indexReport.embedded).toBe(1);
    expect(indexReport.total).toBe(1);

    // Re-index hits the embed cache.
    const cached = await svc.index();
    expect(cached.embedded).toBe(0);
    expect(cached.cachedSkipped).toBe(1);

    // Search picks it up.
    const results = await svc.search("mediapipe hand tracking", 5);
    expect(results.length).toBe(1);
    const r = results[0];
    if (r === undefined) throw new Error("expected result");
    expect(r.license).toBe("MIT");
    expect(r.title).toBe(REPO);
    expect(r.score).toBeGreaterThan(0);
    expect(r.sourceUrl).toBe(`https://github.com/${REPO}`);
  });

  it("license allowlist EXCLUDES MIT → binary skipped, card still indexed (meta-only)", async () => {
    const config = makeConfig(DIR, ["CC0", "PublicDomain"]); // MIT not allowed
    const svc = createProjectRagService({
      config,
      sources: [githubRepoSource([{ owner: "torinmb", repo: "mediapipe-touchdesigner" }])],
      embeddings: MOCK_EMBEDDINGS,
    });
    const report = await svc.sync({});
    expect(report.added).toBe(1);
    expect(report.binariesStored).toBe(0);
    expect(report.skippedNoLicense).toBe(1);

    // No binaries dir created.
    expect(() => statSync(join(DIR, "binaries"))).toThrow();
  });

  it("re-sync with same content keeps added=0 and contentHash stable (fetchedAt excluded from hash)", async () => {
    const config = makeConfig(DIR, ["MIT"]);
    const svc = createProjectRagService({
      config,
      sources: [githubRepoSource([{ owner: "torinmb", repo: "mediapipe-touchdesigner" }])],
      embeddings: MOCK_EMBEDDINGS,
    });
    const first = await svc.sync({});
    expect(first.added).toBe(1);
    const second = await svc.sync({});
    expect(second.added).toBe(0);
    expect(second.updated).toBe(0);
  });

  it("card on disk carries provenance + license + score + binary metadata", async () => {
    const config = makeConfig(DIR, ["MIT"]);
    const svc = createProjectRagService({
      config,
      sources: [githubRepoSource([{ owner: "torinmb", repo: "mediapipe-touchdesigner" }])],
      embeddings: MOCK_EMBEDDINGS,
    });
    await svc.sync({});
    // Find the one card file.
    const list = await svc.listSources();
    expect(list.some((s) => s.name === "github-repo" && s.status === "ready")).toBe(true);
    // Lookup via the service: we know canonical = github:<repo>.
    const { computeProjectId } = await import("../../../src/projectRag/cardParser.js");
    const id = computeProjectId(`github:${REPO}`);
    const card = await svc.getCard(id);
    if (card === undefined) throw new Error("expected card");
    expect(card.license).toBe("MIT");
    expect(card.licenseConfidence).toBe("spdx-detected");
    expect(card.provenance.sourceName).toBe(`github:${REPO}`);
    expect(card.provenance.commitOrVersion).toBe("main");
    expect(card.provenance.fetchedAt).toMatch(/T/);
    expect(card.binaryPath).toMatch(/^binaries\/[0-9a-f]{64}\.tox$/);
    expect(card.binaryHash).toMatch(/^[0-9a-f]{64}$/);
    expect(card.score?.composite).toBeGreaterThan(0);
    // Raw markdown carries the YAML frontmatter.
    const raw = readFileSync(join(DIR, "cards", `${id}.md`), "utf8");
    expect(raw).toContain("license: MIT");
    expect(raw).toContain("licenseConfidence: spdx-detected");
  });
});
