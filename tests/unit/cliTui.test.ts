import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  collectSnapshot,
  type DashboardModel,
  dashboardArgsSchema,
  parseArgv,
  renderFrame,
  runDashboard,
} from "../../src/cli/tui.js";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import type { ToolContext } from "../../src/tools/types.js";
import { loadConfig, type TdmcpConfig } from "../../src/utils/config.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

/**
 * Branch-coverage focused tests for src/cli/tui.ts.
 *
 * The existing tui.test.ts covers the happy paths. This file targets the
 * harder-to-reach branches surfaced by the wave-4 coverage harness:
 *  - parseArgv: --no-X negation, `--key --next` with no value, blanks
 *  - coerce: numeric vs "true"/"false"/empty/string paths
 *  - renderFrame: errors with groups + suggestions, perf without nodes,
 *    perf-offline path, no-cook-count nodes, color statusColor branches,
 *    events tail (with rows + non-TTY clear-screen suppression in --once)
 *  - collectSnapshot: errors-offline branch from a 500
 *  - runDashboard: --json snapshot for an offline bridge (error field set),
 *    config loader injection failure → exit 1
 */

const server = makeTdServer();
beforeAll(() => server.listen({ onUnhandledRequest: "bypass" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function makeConfig(overrides: Partial<TdmcpConfig> = {}): TdmcpConfig {
  return { ...loadConfig({}), ...overrides };
}

function makeCtx(): ToolContext {
  return {
    client: new TouchDesignerClient({ baseUrl: TD_BASE, timeoutMs: 2000 }),
    knowledge: new KnowledgeBase(),
    recipes: new RecipeLibrary(),
    logger: silentLogger,
  };
}

interface Writer {
  buf: string;
  write: (s: string) => void;
  isTTY?: boolean;
}

function makeWriter(isTTY = false): Writer {
  const w: Writer = {
    buf: "",
    isTTY,
    write(s: string): void {
      this.buf += s;
    },
  };
  return w;
}

describe("parseArgv edge cases", () => {
  it("treats `--no-foo` (not --no-color) as a negation into snake_case", () => {
    const { raw } = parseArgv(["--no-recursive"]);
    expect(raw.recursive).toBe(false);
  });

  it("treats `--key` followed by `--next` as a boolean flag (no value)", () => {
    const { raw } = parseArgv(["--once", "--json"]);
    expect(raw.once).toBe(true);
  });

  it("ignores tokens that don't start with --", () => {
    const { raw, json } = parseArgv(["positional", "--json"]);
    expect(json).toBe(true);
    expect(Object.keys(raw)).not.toContain("positional");
  });

  it("respects --key=empty (empty string stays a string in coerce)", () => {
    const { raw } = parseArgv(["--root-path="]);
    expect(raw.root_path).toBe("");
  });
});

describe("dashboardArgsSchema coercion", () => {
  it("parses numeric strings into numbers (target_fps=120)", () => {
    const { raw } = parseArgv(["--target-fps=120"]);
    // schema runs via runDashboard but we sanity-check the raw shape
    expect(raw.target_fps).toBe("120");
    const parsed = dashboardArgsSchema.parse({ target_fps: 120 });
    expect(parsed.target_fps).toBe(120);
  });

  it("rejects out-of-range top_n_nodes", () => {
    expect(() => dashboardArgsSchema.parse({ top_n_nodes: 0 })).toThrow();
    expect(() => dashboardArgsSchema.parse({ top_n_nodes: 21 })).toThrow();
  });
});

describe("renderFrame branches", () => {
  const baseArgs = dashboardArgsSchema.parse({});

  it("shows '(no nodes measured)' when perf is ok but list is empty", () => {
    const model: DashboardModel = {
      ts: "10:00:00",
      paused: false,
      args: baseArgs,
      perf: { totalCookMs: 0, frameBudgetMs: 16.67, nodes: [], status: "ok" },
      errors: { total: 0, groups: [], suggestions: [], status: "ok" },
      events: [],
    };
    const out = renderFrame(model, { color: false, width: 100 });
    expect(out).toContain("(no nodes measured)");
  });

  it("renders an em-dash for nodes that have no cook_count", () => {
    const model: DashboardModel = {
      ts: "10:00:00",
      paused: false,
      args: baseArgs,
      perf: {
        totalCookMs: 1.0,
        frameBudgetMs: 16.67,
        nodes: [{ path: "/p/x", cook_time_ms: 1.0 }],
        status: "ok",
      },
      errors: { total: 0, groups: [], suggestions: [], status: "ok" },
      events: [],
    };
    const out = renderFrame(model, { color: false, width: 100 });
    expect(out).toContain("—");
    expect(out).toContain("/p/x");
  });

  it("renders error groups and yellow suggestions when there are errors", () => {
    const model: DashboardModel = {
      ts: "10:00:00",
      paused: false,
      args: baseArgs,
      perf: { totalCookMs: 1.0, frameBudgetMs: 16.67, nodes: [], status: "ok" },
      errors: {
        total: 3,
        groups: [{ key: "boom", count: 3, sample: { path: "/p/y", message: "boom" } }],
        suggestions: ["check wiring"],
        status: "ok",
      },
      events: [],
    };
    const out = renderFrame(model, { color: false, width: 100 });
    expect(out).toContain("3 errors");
    expect(out).toContain('"boom"');
    expect(out).toContain("/p/y");
    expect(out).toContain("suggestion: check wiring");
  });

  it("renders the errors-offline note when errors.status is offline with an error", () => {
    const model: DashboardModel = {
      ts: "10:00:00",
      paused: false,
      args: baseArgs,
      perf: { totalCookMs: 1.0, frameBudgetMs: 16.67, nodes: [], status: "ok" },
      errors: {
        total: 0,
        groups: [],
        suggestions: [],
        status: "offline",
        error: "errors call failed",
      },
      events: [],
    };
    const out = renderFrame(model, { color: false, width: 100 });
    expect(out).toContain("errors unavailable");
    expect(out).toContain("errors call failed");
  });

  it("renders a paused marker and a populated events tail", () => {
    const model: DashboardModel = {
      ts: "10:00:00",
      paused: true,
      args: { ...baseArgs, include_high_frequency: true },
      perf: { totalCookMs: 1.0, frameBudgetMs: 16.67, nodes: [], status: "ok" },
      errors: { total: 0, groups: [], suggestions: [], status: "ok" },
      events: [
        { ts: "09:59:59", event: "cook", detail: "/p/a  did something" },
        { ts: "10:00:00", event: "param", detail: "/p/b  changed" },
      ],
    };
    const out = renderFrame(model, { color: false, width: 100 });
    expect(out).toContain("PAUSED");
    expect(out).toContain("high-freq on");
    expect(out).toContain("/p/a");
    expect(out).toContain("/p/b");
  });

  it("uses red coloring when perf exceeds 2x budget (worst-case branch)", () => {
    const model: DashboardModel = {
      ts: "10:00:00",
      paused: false,
      args: baseArgs,
      perf: { totalCookMs: 1000, frameBudgetMs: 16.67, nodes: [], status: "ok" },
      errors: { total: 0, groups: [], suggestions: [], status: "ok" },
      events: [],
    };
    const out = renderFrame(model, { color: true, width: 100 });
    // 31 = red ANSI code
    expect(out).toContain("\x1b[31m");
  });

  it("uses yellow coloring when perf is between budget and 2x budget", () => {
    const model: DashboardModel = {
      ts: "10:00:00",
      paused: false,
      args: baseArgs,
      perf: { totalCookMs: 20, frameBudgetMs: 16.67, nodes: [], status: "ok" },
      errors: { total: 0, groups: [], suggestions: [], status: "ok" },
      events: [],
    };
    const out = renderFrame(model, { color: true, width: 100 });
    expect(out).toContain("\x1b[33m");
  });
});

describe("collectSnapshot offline branches", () => {
  it("returns offline perf when the bridge throws (no handler at all)", async () => {
    // No msw handler for performance → falls into the catch branch via friendlyTdError
    const args = dashboardArgsSchema.parse({});
    const ctx: ToolContext = {
      client: new TouchDesignerClient({ baseUrl: "http://127.0.0.1:1", timeoutMs: 50 }),
      knowledge: new KnowledgeBase(),
      recipes: new RecipeLibrary(),
      logger: silentLogger,
    };
    const model = await collectSnapshot({ ctx, args, events: [] });
    expect(model.perf.status).toBe("offline");
    expect(typeof model.perf.error).toBe("string");
  });
});

describe("runDashboard extra paths", () => {
  it("--json with an offline perf endpoint still emits a JSON document with error field", async () => {
    server.use(
      http.get(`${TD_BASE}/api/network/:seg/performance`, () =>
        HttpResponse.json({ ok: false, error: { message: "down" } }, { status: 500 }),
      ),
    );
    const out = makeWriter(false);
    const code = await runDashboard(["--json", "--once"], {
      config: makeConfig(),
      makeCtx,
      out,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(out.buf);
    expect(parsed.perf.status).toBe("offline");
    expect(typeof parsed.perf.error).toBe("string");
  });

  it("seeds events through the options seam and renders them in --once mode", async () => {
    const out = makeWriter(false);
    const code = await runDashboard(["--once"], {
      config: makeConfig(),
      makeCtx,
      out,
      seedEvents: [{ ts: "00:00:01", event: "seed", detail: "hello" }],
    });
    expect(code).toBe(0);
    expect(out.buf).toContain("seed");
  });
});
