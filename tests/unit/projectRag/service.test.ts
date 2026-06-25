import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ProjectRagCard,
  ProjectRagConfig,
  RawProjectItem,
  SourceAdapter,
} from "../../../src/projectRag/index.js";
import {
  computeProjectContentHash,
  computeProjectId,
  createProjectRagService,
  serializeProjectCard,
} from "../../../src/projectRag/index.js";

function makeConfig(dataDir: string, overrides: Partial<ProjectRagConfig> = {}): ProjectRagConfig {
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
    ...overrides,
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

  it("listSources() reports github-repo + github-topic + derivative-local ready and others planned", async () => {
    const svc = createProjectRagService({
      config: makeConfig(DIR),
      embeddings: NOOP_EMBEDDINGS,
    });
    const list = await svc.listSources();
    const byName = new Map(list.map((s) => [s.name, s] as const));
    expect(byName.get("github-repo")?.status).toBe("ready");
    expect(byName.get("github-topic")?.status).toBe("ready");
    expect(byName.get("derivative-local")?.status).toBe("ready");
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

  it("sync() skips restricted/proprietary-paid cards before writing or indexing", async () => {
    const restricted: RawProjectItem = {
      sourceName: "test-source",
      sourceUrl: "https://example.test/restricted.tox",
      canonical: "test-source:restricted.tox",
      title: "Restricted package",
      type: "component",
      tags: ["tox"],
      license: "Restricted",
      licenseConfidence: "declared",
      binaryUrl: "https://example.test/restricted.tox",
    };
    const proprietaryPaid: RawProjectItem = {
      ...restricted,
      sourceUrl: "https://example.test/paid.tox",
      canonical: "test-source:paid.tox",
      title: "Paid package",
      license: "Proprietary-Paid",
      binaryUrl: "https://example.test/paid.tox",
    };
    const source: SourceAdapter = {
      name: "test-source",
      displayName: "Test Source",
      fetchItems: async () => [restricted, proprietaryPaid],
    };
    const svc = createProjectRagService({
      config: makeConfig(DIR),
      sources: [source],
      embeddings: NOOP_EMBEDDINGS,
    });

    const report = await svc.sync({});
    expect(report.added).toBe(0);
    expect(report.binariesStored).toBe(0);
    expect(report.skippedNoLicense).toBe(2);
    expect(await svc.getCard(computeProjectId(restricted.canonical))).toBeUndefined();
    expect(await svc.getCard(computeProjectId(proprietaryPaid.canonical))).toBeUndefined();
    expect(await svc.index()).toEqual({ embedded: 0, cachedSkipped: 0, total: 0 });
  });

  it("sync() downloads and records permissive binaries without changing content hash", async () => {
    const item: RawProjectItem = {
      sourceName: "test-source",
      sourceUrl: "https://example.test/free.tox",
      canonical: "test-source:free.tox",
      title: "Free package",
      type: "component",
      tags: ["tox"],
      license: "MIT",
      licenseConfidence: "declared",
      binaryUrl: "https://example.test/free.tox",
      pathInRepo: "components/free.tox",
    };
    const source: SourceAdapter = {
      name: "test-source",
      displayName: "Test Source",
      fetchItems: async () => [item],
    };
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(new Uint8Array([1, 2, 3])));
    const svc = createProjectRagService({
      config: makeConfig(DIR),
      sources: [source],
      embeddings: NOOP_EMBEDDINGS,
      fetchImpl,
    });

    const report = await svc.sync({});
    const stored = await svc.getCard(computeProjectId(item.canonical));

    expect(report.added).toBe(1);
    expect(report.binariesStored).toBe(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://example.test/free.tox",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(stored?.binaryPath).toMatch(/^binaries\/[0-9a-f]{64}\.tox$/);
    expect(stored?.binaryHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.analysisStatus).toBeUndefined();
    expect(existsSync(join(DIR, stored?.binaryPath ?? "missing"))).toBe(true);
  });

  it("sync({sources:[missing], bridge:true}) still runs the bridge pass over persisted cards", async () => {
    const id = computeProjectId("github:foo/filter#1").slice(0, 64).padEnd(64, "0").slice(0, 64);
    const cardsDir = join(DIR, "cards");
    mkdirSync(cardsDir, { recursive: true });
    const card: ProjectRagCard = {
      schemaVersion: 2,
      id,
      kind: "project",
      type: "component",
      title: "Filtered bridge card",
      tags: [],
      contentHash: "",
      provenance: {
        sourceName: "github:foo/filter",
        sourceUrl: "https://github.com/foo/filter",
        canonical: "github:foo/filter#1",
        fetchedAt: "2026-06-18T00:00:00Z",
      },
      license: "MIT",
      licenseConfidence: "spdx-detected",
      binaryPath: "binaries/filter.tox",
    };
    const final = { ...card, contentHash: computeProjectContentHash(card) };
    writeFileSync(join(cardsDir, `${id}.md`), serializeProjectCard(final), "utf8");
    const source: SourceAdapter = {
      name: "registered-source",
      displayName: "Registered Source",
      fetchItems: async () => {
        throw new Error("should not fetch unmatched source");
      },
    };
    const calls: string[] = [];
    const svc = createProjectRagService({
      config: makeConfig(DIR),
      sources: [source],
      embeddings: NOOP_EMBEDDINGS,
      bridgeAnalyzeImpl: async (p) => {
        calls.push(p);
        return { status: "ok", errorCount: 0 };
      },
    });

    const report = await svc.sync({ sources: ["missing-source"], bridge: true });

    expect(report.bridgeAnalysis).toEqual({ attempted: 1, ok: 1, failed: 0, skipped: 0 });
    expect(calls).toHaveLength(1);
  });

  it("index() propagates embedding failures after logging them", async () => {
    const canonical = "github:foo/bar/embed-fail.tox";
    const id = computeProjectId(canonical);
    const card: ProjectRagCard = {
      schemaVersion: 2,
      id,
      kind: "project",
      type: "component",
      title: "Embed fail",
      tags: ["embed"],
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
    const logger = { ...console, error: vi.fn(), warn: vi.fn(), debug: vi.fn(), info: vi.fn() };
    const svc = createProjectRagService({
      config: makeConfig(DIR),
      sources: [],
      embeddings: {
        embed: async () => {
          throw new Error("ollama offline");
        },
      },
      logger,
    });

    await expect(svc.index()).rejects.toThrow("ollama offline");
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("embedding failed"));
  });

  it("passes bridgeToken to quarantine probe and direct analyze", async () => {
    const probe = vi.fn().mockResolvedValue({
      reachable: true,
      baseUrl: "http://127.0.0.1:9981",
    });
    const analyze = vi.fn().mockResolvedValue({ status: "skipped", reason: "fixture" });
    const svc = createProjectRagService({
      config: makeConfig(DIR, { bridgeToken: "bridge-secret" }),
      sources: [],
      embeddings: NOOP_EMBEDDINGS,
      bridgeProbeImpl: probe,
      bridgeAnalyzeImpl: analyze,
    });

    await svc.probeBridge();
    await svc.analyze("/tmp/example.tox");

    expect(probe).toHaveBeenCalledWith(
      expect.objectContaining({ bridgePort: 9981, bridgeToken: "bridge-secret" }),
    );
    expect(analyze).toHaveBeenCalledWith(
      "/tmp/example.tox",
      expect.objectContaining({ bridgePort: 9981, bridgeToken: "bridge-secret" }),
    );
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

  it("sync({bridge:true}) passes an ABSOLUTE artifact path even when dataDir is relative (regression)", async () => {
    // Slice C live-validation found `sync --bridge` failing with
    // "artifactPath must be absolute" because the default dataDir
    // (`.tdmcp/creative-rag`) is relative and runBridgePass used `join`, not
    // `resolve`. The quarantine analyzer rejects relative paths.
    // A relative dataDir is the bug trigger; we derive it from cwd (no chdir,
    // which would leak into other test files sharing the worker process).
    const relDir = relative(process.cwd(), DIR);
    expect(isAbsolute(relDir)).toBe(false);
    const id = computeProjectId("github:foo/rel#1").slice(0, 64).padEnd(64, "0").slice(0, 64);
    writePersistedCard(relDir, { id, license: "MIT", binaryPath: "binaries/cool.tox" });
    const calls: string[] = [];
    const svc = createProjectRagService({
      config: makeConfig(relDir), // RELATIVE dataDir — the bug trigger
      sources: [],
      embeddings: NOOP_EMBEDDINGS,
      bridgeAnalyzeImpl: async (p) => {
        calls.push(p);
        return { status: "ok", errorCount: 0 };
      },
    });
    const report = await svc.sync({ bridge: true });
    expect(report.bridgeAnalysis).toEqual({ attempted: 1, ok: 1, failed: 0, skipped: 0 });
    expect(calls).toHaveLength(1);
    expect(isAbsolute(calls[0] as string)).toBe(true);
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
