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

  it("listSources() reports github-repo ready (F1) and others planned", async () => {
    const svc = createProjectRagService({
      config: makeConfig(DIR),
      embeddings: NOOP_EMBEDDINGS,
    });
    const list = await svc.listSources();
    const byName = new Map(list.map((s) => [s.name, s] as const));
    expect(byName.get("github-repo")?.status).toBe("ready");
    expect(byName.get("derivative-local")?.status).toBe("planned");
    expect(byName.get("github-topic")?.status).toBe("planned");
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
