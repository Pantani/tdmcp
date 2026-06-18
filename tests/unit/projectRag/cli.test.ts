import { describe, expect, it } from "vitest";
import type { ProjectRagConfig, ProjectRagService } from "../../../src/projectRag/index.js";
import { runProjectRagCli } from "../../../src/projectRag/index.js";

function makeConfig(overrides: Partial<ProjectRagConfig> = {}): ProjectRagConfig {
  return {
    enabled: true,
    dataDir: "/tmp/prag-cli-test",
    ollamaUrl: "http://127.0.0.1:11434",
    embedModel: "nomic-embed-text",
    licenseAllowlist: ["CC0", "MIT"],
    embedBatch: 64,
    backend: "jsonl",
    bridgeAnalysis: false,
    bridgePort: 9981,
    analyzeTimeoutMs: 30000,
    scoreWeights: { technical: 0.45, license: 0.25, freshness: 0.15, reliability: 0.15 },
    ...overrides,
  };
}

function captureIO() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: (s: string) => out.push(s),
    stderr: (s: string) => err.push(s),
  };
}

const noopSvc: ProjectRagService = {
  sync: async () => ({
    added: 0,
    updated: 0,
    tombstoned: 0,
    skippedNoLicense: 0,
    binariesStored: 0,
    perSource: {},
  }),
  index: async () => ({ embedded: 0, cachedSkipped: 0, total: 0 }),
  search: async () => [],
  getCard: async () => undefined,
  listSources: async () => [
    { name: "derivative-local", displayName: "Local TD", status: "planned", reason: "F1" },
  ],
};

describe("projectRag CLI gating + help", () => {
  it("--help prints help and exits 0", async () => {
    const io = captureIO();
    const code = await runProjectRagCli(["--help"], {
      config: makeConfig(),
      service: noopSvc,
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(0);
    expect(io.out.join("")).toContain("tdmcp project-rag");
    expect(io.out.join("")).toContain("sources");
  });

  it("disabled config prints friendly message and exits 0", async () => {
    const io = captureIO();
    const code = await runProjectRagCli(["sources"], {
      config: makeConfig({ enabled: false }),
      service: noopSvc,
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(0);
    expect(io.out.join("")).toMatch(/Project RAG is disabled/);
  });

  it("missing config returns exit 2", async () => {
    const io = captureIO();
    const code = await runProjectRagCli(["sources"], {
      service: noopSvc,
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(2);
  });

  it("unknown subcommand returns exit 2", async () => {
    const io = captureIO();
    const code = await runProjectRagCli(["unknown-cmd"], {
      config: makeConfig(),
      service: noopSvc,
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(2);
    expect(io.err.join("")).toContain("unknown command");
  });
});

describe("projectRag CLI commands", () => {
  it("sources prints planned source list", async () => {
    const io = captureIO();
    const code = await runProjectRagCli(["sources"], {
      config: makeConfig(),
      service: noopSvc,
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(0);
    expect(io.out.join("")).toContain("derivative-local");
    expect(io.out.join("")).toContain("planned");
  });

  it("sources --json emits JSON list", async () => {
    const io = captureIO();
    const code = await runProjectRagCli(["sources", "--json"], {
      config: makeConfig(),
      service: noopSvc,
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(io.out.join(""));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].name).toBe("derivative-local");
  });

  it("sync prints 'No sources configured' in F0", async () => {
    const io = captureIO();
    await runProjectRagCli(["sync"], {
      config: makeConfig(),
      service: noopSvc,
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(io.out.join("")).toContain("No sources configured");
  });

  it("search needs a query (exit 2)", async () => {
    const io = captureIO();
    const code = await runProjectRagCli(["search"], {
      config: makeConfig(),
      service: noopSvc,
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(2);
    expect(io.err.join("")).toMatch(/search needs a query/);
  });

  it("search returns 'No results.' in F0", async () => {
    const io = captureIO();
    const code = await runProjectRagCli(["search", "hand", "tracking"], {
      config: makeConfig(),
      service: noopSvc,
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(0);
    expect(io.out.join("")).toContain("No results.");
  });

  it("info needs an id (exit 2)", async () => {
    const io = captureIO();
    const code = await runProjectRagCli(["info"], {
      config: makeConfig(),
      service: noopSvc,
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(2);
  });

  it("info on missing card returns exit 1", async () => {
    const io = captureIO();
    const code = await runProjectRagCli(["info", "a".repeat(64)], {
      config: makeConfig(),
      service: noopSvc,
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(1);
  });

  it("invalid --license value returns exit 2 with usage", async () => {
    const io = captureIO();
    const code = await runProjectRagCli(["search", "q", "--license", "NOTALICENSE"], {
      config: makeConfig(),
      service: noopSvc,
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(2);
    expect(io.err.join("")).toContain("--license");
  });
});
