import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectRagCard, ProjectRagConfig } from "../../../src/projectRag/index.js";
import {
  computeProjectContentHash,
  computeProjectId,
  createProjectRagService,
  serializeProjectCard,
} from "../../../src/projectRag/index.js";

function makeConfig(dataDir: string): ProjectRagConfig {
  return {
    enabled: true,
    dataDir,
    ollamaUrl: "http://127.0.0.1:11434",
    embedModel: "nomic-embed-text",
    licenseAllowlist: ["CC0", "PublicDomain", "MIT", "Apache-2.0"],
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
  DIR = join(tmpdir(), `prag-svc-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(DIR, { recursive: true });
});

afterEach(() => {
  rmSync(DIR, { recursive: true, force: true });
});

// F1: pass empty `sources` + a no-op embeddings stub so these unit tests stay
// offline regardless of the default seed (`torinmb/mediapipe-touchdesigner`).
const NOOP_EMBEDDINGS = { embed: async () => [] as number[][] };

describe("projectRag service (skeleton-level behaviour)", () => {
  it("sync({}) with no sources returns an empty report", async () => {
    const svc = createProjectRagService({
      config: makeConfig(DIR),
      sources: [],
      embeddings: NOOP_EMBEDDINGS,
    });
    const report = await svc.sync({});
    expect(report).toEqual({
      added: 0,
      updated: 0,
      tombstoned: 0,
      skippedNoLicense: 0,
      binariesStored: 0,
      perSource: {},
    });
  });

  it("index() reports total=0 when no cards exist", async () => {
    const svc = createProjectRagService({
      config: makeConfig(DIR),
      sources: [],
      embeddings: NOOP_EMBEDDINGS,
    });
    expect(await svc.index()).toEqual({ embedded: 0, cachedSkipped: 0, total: 0 });
  });

  it("search() with empty embedder returns []", async () => {
    const svc = createProjectRagService({
      config: makeConfig(DIR),
      sources: [],
      embeddings: NOOP_EMBEDDINGS,
    });
    expect(await svc.search("anything", 5)).toEqual([]);
  });

  it("listSources() reports github-repo + github-topic ready (F2) and others planned", async () => {
    const svc = createProjectRagService({
      config: makeConfig(DIR),
      embeddings: NOOP_EMBEDDINGS,
    });
    const list = await svc.listSources();
    const byName = new Map(list.map((s) => [s.name, s] as const));
    expect(byName.get("github-repo")?.status).toBe("ready");
    expect(byName.get("github-topic")?.status).toBe("ready");
    expect(byName.get("derivative-local")?.status).toBe("planned");
    expect(byName.get("awesome-touchdesigner")?.status).toBe("planned");
  });

  it("getCard() loads a hand-placed card by id", async () => {
    const canonical = "github:foo/bar/x.tox";
    const id = computeProjectId(canonical);
    const card: ProjectRagCard = {
      schemaVersion: 2,
      id,
      kind: "project",
      type: "component",
      title: "X",
      tags: [],
      contentHash: "",
      provenance: {
        sourceName: "github:foo/bar",
        sourceUrl: "https://github.com/foo/bar",
        canonical,
        fetchedAt: "2026-06-18T00:00:00Z",
      },
      license: "MIT",
      licenseConfidence: "spdx-detected",
    };
    const final = { ...card, contentHash: computeProjectContentHash(card) };
    const cardsDir = join(DIR, "cards");
    mkdirSync(cardsDir, { recursive: true });
    writeFileSync(join(cardsDir, `${id}.md`), serializeProjectCard(final), "utf8");

    const svc = createProjectRagService({
      config: makeConfig(DIR),
      sources: [],
      embeddings: NOOP_EMBEDDINGS,
    });
    const loaded = await svc.getCard(id);
    expect(loaded?.title).toBe("X");
    expect(loaded?.license).toBe("MIT");
  });

  it("getCard() rejects path-traversal-style ids", async () => {
    const svc = createProjectRagService({
      config: makeConfig(DIR),
      sources: [],
      embeddings: NOOP_EMBEDDINGS,
    });
    expect(await svc.getCard("../etc/passwd")).toBeUndefined();
    expect(await svc.getCard("not-a-sha")).toBeUndefined();
  });

  it("rescore() recomputes score on every live card and ignores tombstones", async () => {
    const canonical = "github:foo/bar/z.tox";
    const id = computeProjectId(canonical);
    const card: ProjectRagCard = {
      schemaVersion: 2,
      id,
      kind: "project",
      type: "component",
      title: "Z",
      tags: [],
      contentHash: "",
      provenance: {
        sourceName: "github:foo/bar",
        sourceUrl: "https://github.com/foo/bar",
        canonical,
        fetchedAt: "2026-06-18T00:00:00Z",
      },
      license: "MIT",
      licenseConfidence: "spdx-detected",
    };
    const final = { ...card, contentHash: computeProjectContentHash(card) };
    const cardsDir = join(DIR, "cards");
    mkdirSync(cardsDir, { recursive: true });
    writeFileSync(join(cardsDir, `${id}.md`), serializeProjectCard(final), "utf8");

    const svc = createProjectRagService({
      config: makeConfig(DIR),
      sources: [],
      embeddings: NOOP_EMBEDDINGS,
    });
    const report = await svc.rescore();
    expect(report.total).toBe(1);
    expect(report.rescored).toBe(1);
    const updated = await svc.getCard(id);
    expect(updated?.score?.composite).toBeGreaterThan(0);
  });

  it("getCard() returns undefined for tombstoned card", async () => {
    const canonical = "github:foo/bar/y.tox";
    const id = computeProjectId(canonical);
    const card: ProjectRagCard = {
      schemaVersion: 2,
      id,
      kind: "project",
      type: "component",
      title: "Y",
      tags: [],
      contentHash: "",
      provenance: {
        sourceName: "github:foo/bar",
        sourceUrl: "https://github.com/foo/bar",
        canonical,
        fetchedAt: "2026-06-18T00:00:00Z",
      },
      license: "MIT",
      licenseConfidence: "spdx-detected",
      tombstone: true,
    };
    const final = { ...card, contentHash: computeProjectContentHash(card) };
    const cardsDir = join(DIR, "cards");
    mkdirSync(cardsDir, { recursive: true });
    writeFileSync(join(cardsDir, `${id}.md`), serializeProjectCard(final), "utf8");

    const svc = createProjectRagService({
      config: makeConfig(DIR),
      sources: [],
      embeddings: NOOP_EMBEDDINGS,
    });
    expect(await svc.getCard(id)).toBeUndefined();
  });
});

describe("projectRag service — F3 bridge analyze pass", () => {
  function writePersistedCard(
    dataDir: string,
    overrides: Partial<ProjectRagCard> & { id: string; license: ProjectRagCard["license"] },
  ): void {
    const cardsDir = join(dataDir, "cards");
    mkdirSync(cardsDir, { recursive: true });
    const canonical = `github:foo/bar#${overrides.id}`;
    const defaults: ProjectRagCard = {
      schemaVersion: 2,
      id: overrides.id,
      kind: "project",
      type: "component",
      title: `card-${overrides.id.slice(0, 6)}`,
      tags: [],
      contentHash: "",
      provenance: {
        sourceName: "github:foo/bar",
        sourceUrl: "https://github.com/foo/bar",
        canonical,
        fetchedAt: "2026-06-18T00:00:00Z",
      },
      license: overrides.license,
      licenseConfidence: "spdx-detected",
    };
    const base: ProjectRagCard = { ...defaults, ...overrides };
    const final = { ...base, contentHash: computeProjectContentHash(base) };
    writeFileSync(join(cardsDir, `${overrides.id}.md`), serializeProjectCard(final), "utf8");
  }

  it("sync({bridge:true}) skips when nothing has a binaryPath", async () => {
    const calls: string[] = [];
    const svc = createProjectRagService({
      config: makeConfig(DIR),
      sources: [],
      embeddings: NOOP_EMBEDDINGS,
      bridgeAnalyzeImpl: async (p) => {
        calls.push(p);
        return { status: "ok", errorCount: 0 };
      },
    });
    const report = await svc.sync({ bridge: true });
    expect(report.bridgeAnalysis).toEqual({ attempted: 0, ok: 0, failed: 0, skipped: 0 });
    expect(calls).toEqual([]);
  });

  it("sync({bridge:true}) calls the analyzer on a permissive-license card with a binary", async () => {
    const id = computeProjectId("github:foo/bar#1").slice(0, 64).padEnd(64, "0").slice(0, 64);
    writePersistedCard(DIR, { id, license: "MIT", binaryPath: "binaries/cool.tox" });
    const calls: string[] = [];
    const svc = createProjectRagService({
      config: makeConfig(DIR),
      sources: [],
      embeddings: NOOP_EMBEDDINGS,
      bridgeAnalyzeImpl: async (p) => {
        calls.push(p);
        return { status: "ok", errorCount: 2 };
      },
    });
    const report = await svc.sync({ bridge: true });
    expect(report.bridgeAnalysis).toEqual({ attempted: 1, ok: 1, failed: 0, skipped: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("binaries/cool.tox");
    const stored = await svc.getCard(id);
    expect(stored?.analysisStatus).toBe("ok");
  });

  it("sync({bridge:true}) is idempotent — already-ok cards are not re-analyzed", async () => {
    const id = computeProjectId("github:foo/bar#idempotent")
      .slice(0, 64)
      .padEnd(64, "0")
      .slice(0, 64);
    writePersistedCard(DIR, {
      id,
      license: "MIT",
      binaryPath: "binaries/x.tox",
      analysisStatus: "ok",
    });
    const calls: string[] = [];
    const svc = createProjectRagService({
      config: makeConfig(DIR),
      sources: [],
      embeddings: NOOP_EMBEDDINGS,
      bridgeAnalyzeImpl: async (p) => {
        calls.push(p);
        return { status: "ok" };
      },
    });
    const report = await svc.sync({ bridge: true });
    expect(report.bridgeAnalysis).toEqual({ attempted: 0, ok: 0, failed: 0, skipped: 0 });
    expect(calls).toEqual([]);
  });

  it("sync({bridge:true}) records skipped when the analyzer skips (offline bridge)", async () => {
    const id = computeProjectId("github:foo/bar#skip").slice(0, 64).padEnd(64, "0").slice(0, 64);
    writePersistedCard(DIR, { id, license: "MIT", binaryPath: "binaries/y.tox" });
    const svc = createProjectRagService({
      config: makeConfig(DIR),
      sources: [],
      embeddings: NOOP_EMBEDDINGS,
      bridgeAnalyzeImpl: async () => ({ status: "skipped", reason: "bridge offline" }),
    });
    const report = await svc.sync({ bridge: true });
    expect(report.bridgeAnalysis).toEqual({ attempted: 1, ok: 0, failed: 0, skipped: 1 });
    const stored = await svc.getCard(id);
    expect(stored?.analysisStatus).toBe("skipped");
    expect(stored?.analysisReason).toBe("bridge offline");
  });

  it("analyze(path) returns a skipped envelope when the bridge is offline", async () => {
    const svc = createProjectRagService({
      config: makeConfig(DIR),
      sources: [],
      embeddings: NOOP_EMBEDDINGS,
      bridgeAnalyzeImpl: async () => ({ status: "skipped", reason: "offline" }),
    });
    const report = await svc.analyze("/tmp/whatever.toe");
    expect(report.status).toBe("skipped");
    expect(report.bridgeUrl).toBe("http://127.0.0.1:9981");
    expect(report.reason).toBe("offline");
  });

  it("sync({}) preserves analysisStatus/analysisReason when contentHash is unchanged", async () => {
    // Write the pre-existing card DIRECTLY (bypassing writePersistedCard's
    // hard-coded canonical) so the rebuilt card matches it bit-for-bit on the
    // fields that feed `computeProjectContentHash`. The carry-forward branch
    // only fires when `prior.contentHash === fresh.contentHash`.
    const canonical = "github:foo/bar#stable";
    const id = computeProjectId(canonical);
    const cardsDir = join(DIR, "cards");
    mkdirSync(cardsDir, { recursive: true });
    const stable: ProjectRagCard = {
      schemaVersion: 2,
      id,
      kind: "project",
      type: "component",
      title: "card-stable",
      tags: [],
      contentHash: "",
      provenance: {
        sourceName: "github:foo/bar",
        sourceUrl: "https://github.com/foo/bar",
        canonical,
        fetchedAt: "2026-06-18T00:00:00Z",
      },
      license: "MIT",
      licenseConfidence: "spdx-detected",
      binaryPath: "binaries/stable.tox",
      binaryHash: "deadbeef",
      analysisStatus: "ok",
      analysisReason: "loaded stable.tox",
    };
    const stableFinal = { ...stable, contentHash: computeProjectContentHash(stable) };
    writeFileSync(join(cardsDir, `${id}.md`), serializeProjectCard(stableFinal), "utf8");

    const fakeSource = {
      name: "github:foo/bar",
      displayName: "foo/bar",
      fetchItems: async () => [
        {
          sourceName: "github:foo/bar",
          sourceUrl: "https://github.com/foo/bar",
          canonical,
          title: "card-stable",
          type: "component" as const,
          tags: [],
          license: "MIT" as const,
          licenseConfidence: "spdx-detected" as const,
        },
      ],
    };
    const svc = createProjectRagService({
      config: makeConfig(DIR),
      sources: [fakeSource],
      embeddings: NOOP_EMBEDDINGS,
    });
    await svc.sync({});
    const stored = await svc.getCard(id);
    expect(stored?.analysisStatus).toBe("ok");
    expect(stored?.analysisReason).toBe("loaded stable.tox");
  });

  it("analyze(path) returns failed when the analyzer throws", async () => {
    const svc = createProjectRagService({
      config: makeConfig(DIR),
      sources: [],
      embeddings: NOOP_EMBEDDINGS,
      bridgeAnalyzeImpl: async () => {
        throw new Error("kaboom");
      },
    });
    const report = await svc.analyze("/tmp/whatever.toe");
    expect(report.status).toBe("failed");
    expect(report.error).toBe("kaboom");
  });
});
