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
  rescore: async () => ({ rescored: 0, total: 0 }),
  search: async () => [],
  getCard: async () => undefined,
  listSources: async () => [
    { name: "derivative-local", displayName: "Local TD", status: "planned", reason: "F1" },
  ],
  analyze: async () => ({
    status: "skipped",
    reason: "no bridge",
    bridgeUrl: "http://127.0.0.1:9981",
  }),
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

  it("sync --topic + --cap forwards to service.sync", async () => {
    let seen: Parameters<ProjectRagService["sync"]>[0] | undefined;
    const svc: ProjectRagService = {
      ...noopSvc,
      sync: async (opts) => {
        seen = opts;
        return {
          added: 0,
          updated: 0,
          tombstoned: 0,
          skippedNoLicense: 0,
          binariesStored: 0,
          perSource: {},
        };
      },
    };
    const io = captureIO();
    const code = await runProjectRagCli(
      ["sync", "--topic", "touchdesigner-components", "--cap", "10"],
      { config: makeConfig(), service: svc, stdout: io.stdout, stderr: io.stderr },
    );
    expect(code).toBe(0);
    expect(seen?.topicsCsv).toBe("touchdesigner-components");
    expect(seen?.topicCap).toBe(10);
  });

  it("reindex --rescore calls service.rescore and prints summary", async () => {
    let called = false;
    const svc: ProjectRagService = {
      ...noopSvc,
      rescore: async () => {
        called = true;
        return { rescored: 3, total: 5 };
      },
    };
    const io = captureIO();
    const code = await runProjectRagCli(["reindex", "--rescore"], {
      config: makeConfig(),
      service: svc,
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(0);
    expect(called).toBe(true);
    expect(io.out.join("")).toContain("rescored: 3 of 5");
  });

  it("reindex without --rescore returns exit 2 with hint", async () => {
    const io = captureIO();
    const code = await runProjectRagCli(["reindex"], {
      config: makeConfig(),
      service: noopSvc,
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(2);
    expect(io.err.join("")).toContain("--rescore");
  });

  it("analyze without a path returns exit 2", async () => {
    const io = captureIO();
    const code = await runProjectRagCli(["analyze"], {
      config: makeConfig(),
      service: noopSvc,
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(2);
    expect(io.err.join("")).toMatch(/analyze needs an absolute/);
  });

  it("analyze on offline bridge returns exit 0 with skipped status", async () => {
    const svc: ProjectRagService = {
      ...noopSvc,
      analyze: async () => ({
        status: "skipped",
        reason: "bridge offline at http://127.0.0.1:9981",
        bridgeUrl: "http://127.0.0.1:9981",
      }),
    };
    const io = captureIO();
    const code = await runProjectRagCli(["analyze", "/tmp/example.toe"], {
      config: makeConfig(),
      service: svc,
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(0);
    expect(io.out.join("")).toContain("analyze skipped");
    expect(io.out.join("")).toContain("9981");
  });

  it("analyze with --json emits the report and exits 0 on skip", async () => {
    const svc: ProjectRagService = {
      ...noopSvc,
      analyze: async () => ({
        status: "skipped",
        reason: "offline",
        bridgeUrl: "http://127.0.0.1:9981",
      }),
    };
    const io = captureIO();
    const code = await runProjectRagCli(["analyze", "/tmp/x.tox", "--json"], {
      config: makeConfig(),
      service: svc,
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(io.out.join(""));
    expect(parsed.status).toBe("skipped");
    expect(parsed.bridgeUrl).toBe("http://127.0.0.1:9981");
  });

  it("analyze on real failure returns exit 1", async () => {
    const svc: ProjectRagService = {
      ...noopSvc,
      analyze: async () => ({
        status: "failed",
        error: "missing artifact",
        bridgeUrl: "http://127.0.0.1:9981",
      }),
    };
    const io = captureIO();
    const code = await runProjectRagCli(["analyze", "/tmp/missing.toe"], {
      config: makeConfig(),
      service: svc,
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(1);
  });

  it("bridge install prints walkthrough and probes the bridge (offline)", async () => {
    const svc: ProjectRagService = {
      ...noopSvc,
      analyze: async () => ({
        status: "skipped",
        reason: "offline",
        bridgeUrl: "http://127.0.0.1:9981",
      }),
    };
    const io = captureIO();
    const code = await runProjectRagCli(["bridge", "install"], {
      config: makeConfig(),
      service: svc,
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(0);
    expect(io.out.join("")).toContain("quarantine bridge setup");
    expect(io.out.join("")).toContain("OFFLINE");
    // Critical: never recommends port 9980.
    expect(io.out.join("")).toMatch(/9981/);
  });

  it("bridge install --json emits machine-readable probe result", async () => {
    const svc: ProjectRagService = {
      ...noopSvc,
      analyze: async () => ({
        status: "skipped",
        bridgeUrl: "http://127.0.0.1:9981",
      }),
    };
    const io = captureIO();
    const code = await runProjectRagCli(["bridge", "install", "--json"], {
      config: makeConfig(),
      service: svc,
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(io.out.join(""));
    expect(parsed.bridgeUrl).toBe("http://127.0.0.1:9981");
    expect(parsed.reachable).toBe(false);
    expect(parsed.probeStatus).toBe("skipped");
  });

  it("bridge install reports REACHABLE when probe returns non-skipped", async () => {
    const svc: ProjectRagService = {
      ...noopSvc,
      analyze: async () => ({
        status: "failed",
        error: "artifact does not exist",
        bridgeUrl: "http://127.0.0.1:9981",
      }),
    };
    const io = captureIO();
    const code = await runProjectRagCli(["bridge", "install"], {
      config: makeConfig(),
      service: svc,
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(0);
    expect(io.out.join("")).toContain("REACHABLE");
  });

  it("sync --bridge forwards bridge:true to service.sync and prints sub-report", async () => {
    let seenOpts: Parameters<ProjectRagService["sync"]>[0] | undefined;
    const svc: ProjectRagService = {
      ...noopSvc,
      sync: async (opts) => {
        seenOpts = opts;
        return {
          added: 1,
          updated: 0,
          tombstoned: 0,
          skippedNoLicense: 0,
          binariesStored: 1,
          perSource: { "github-repo": 1 },
          bridgeAnalysis: { attempted: 1, ok: 1, failed: 0, skipped: 0 },
        };
      },
    };
    const io = captureIO();
    const code = await runProjectRagCli(["sync", "--bridge"], {
      config: makeConfig(),
      service: svc,
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(0);
    expect(seenOpts?.bridge).toBe(true);
    expect(io.out.join("")).toContain("bridge: 1 attempted, 1 ok");
  });

  it("search output renders copyleft badge for GPL-3.0 results", async () => {
    const svc: ProjectRagService = {
      ...noopSvc,
      search: async () => [
        {
          id: "x".repeat(64),
          score: 0.5,
          cosineScore: 0.5,
          title: "DBraun/TouchDesigner_Shared",
          type: "component",
          license: "GPL-3.0",
          licenseConfidence: "spdx-detected",
          sourceUrl: "https://github.com/DBraun/TouchDesigner_Shared",
          sourceName: "github:DBraun/TouchDesigner_Shared",
          tags: ["tox"],
        },
      ],
    };
    const io = captureIO();
    const code = await runProjectRagCli(["search", "shared"], {
      config: makeConfig(),
      service: svc,
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(0);
    expect(io.out.join("")).toContain("GPL-3.0 · copyleft");
  });
});
