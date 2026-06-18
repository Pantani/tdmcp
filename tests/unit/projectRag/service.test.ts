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

describe("projectRag service (F0 skeleton)", () => {
  it("sync({}) returns an empty report — no sources wired in F0", async () => {
    const svc = createProjectRagService({ config: makeConfig(DIR) });
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
    const svc = createProjectRagService({ config: makeConfig(DIR) });
    expect(await svc.index()).toEqual({ embedded: 0, cachedSkipped: 0, total: 0 });
  });

  it("search() returns [] (no embedder wired in F0)", async () => {
    const svc = createProjectRagService({ config: makeConfig(DIR) });
    expect(await svc.search("anything", 5)).toEqual([]);
  });

  it("listSources() surfaces the planned source slots", async () => {
    const svc = createProjectRagService({ config: makeConfig(DIR) });
    const list = await svc.listSources();
    const names = list.map((s) => s.name).sort();
    expect(names).toContain("derivative-local");
    expect(names).toContain("github-repo");
    expect(list.every((s) => s.status === "planned")).toBe(true);
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

    const svc = createProjectRagService({ config: makeConfig(DIR) });
    const loaded = await svc.getCard(id);
    expect(loaded?.title).toBe("X");
    expect(loaded?.license).toBe("MIT");
  });

  it("getCard() rejects path-traversal-style ids", async () => {
    const svc = createProjectRagService({ config: makeConfig(DIR) });
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

    const svc = createProjectRagService({ config: makeConfig(DIR) });
    expect(await svc.getCard(id)).toBeUndefined();
  });
});
