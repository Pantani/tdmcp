import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "../../src/cli/agent.js";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

const server = makeTdServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const makeCtx = (): ToolContext => ({
  client: new TouchDesignerClient({ baseUrl: TD_BASE, timeoutMs: 2000 }),
  knowledge: new KnowledgeBase(),
  recipes: new RecipeLibrary(),
  logger: silentLogger,
});

describe("tdmcp-agent CLI", () => {
  it("prints usage with --help (no TD needed)", async () => {
    const r = await runCli(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("tdmcp-agent");
    expect(r.stdout).toContain("nodes find");
  });

  it("emits a JSON Schema for `schema <command>`", async () => {
    const r = await runCli(["schema", "nodes", "list"]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.command).toBe("nodes list");
    expect(JSON.stringify(doc.input)).toContain("parent_path");
  });

  it("rejects an unknown command with exit code 2", async () => {
    const r = await runCli(["nodes", "frobnicate"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Unknown command");
  });

  it("validates and echoes a mutation under --dry-run without calling TD", async () => {
    const r = await runCli([
      "nodes",
      "create",
      "--dry-run",
      "--params",
      '{"parent_path":"/project1","type":"noiseTOP"}',
    ]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.dryRun).toBe(true);
    expect(doc.command).toBe("nodes create");
    expect(doc.args.type).toBe("noiseTOP");
  });

  it("blocks exec escape hatches without --allow-unsafe", async () => {
    const r = await runCli(["exec", "python", "--params", '{"script":"print(1)"}']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--allow-unsafe");
  });

  it("locks exec out entirely when TDMCP_RAW_PYTHON=off, even with --allow-unsafe", async () => {
    const makeCtxLocked = (): ToolContext => ({ ...makeCtx(), allowRawPython: false });
    const r = await runCli(
      ["exec", "python", "--allow-unsafe", "--params", '{"script":"print(1)"}'],
      { makeCtx: makeCtxLocked },
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("disabled");
  });

  it("runs exec python with --allow-unsafe against the mocked bridge", async () => {
    const r = await runCli(
      ["exec", "python", "--allow-unsafe", "--params", '{"script":"print(1)"}'],
      { makeCtx },
    );
    expect(r.code).toBe(0);
  });

  it("rejects invalid JSON in --params", async () => {
    const r = await runCli(["nodes", "list", "--params", "{not json"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Invalid JSON");
  });

  it("runs an offline KB command and prints JSON", async () => {
    const r = await runCli(["classes", "list", "--params", '{"filter":"app"}'], { makeCtx });
    expect(r.code).toBe(0);
    expect(() => JSON.parse(r.stdout)).not.toThrow();
    expect(JSON.parse(r.stdout)).toHaveProperty("classes");
  });

  it("finds nodes through the mocked bridge", async () => {
    const r = await runCli(
      ["nodes", "find", "--params", '{"parent_path":"/project1","recursive":false,"type":"null"}'],
      { makeCtx },
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("/project1/null1");
  });

  it("streams list results as NDJSON", async () => {
    const r = await runCli(
      ["nodes", "list", "--output", "ndjson", "--params", '{"detail_level":"full"}'],
      { makeCtx },
    );
    expect(r.code).toBe(0);
    const lines = r.stdout.trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(r.stdout).toContain("noise1");
    expect(r.stdout).toContain("null1");
  });
});
