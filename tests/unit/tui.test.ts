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

const ORIGINAL_NO_COLOR = process.env.NO_COLOR;
afterEach(() => {
  if (ORIGINAL_NO_COLOR === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = ORIGINAL_NO_COLOR;
});

describe("dashboardArgsSchema", () => {
  it("defaults match the spec", () => {
    const a = dashboardArgsSchema.parse({});
    expect(a).toEqual({
      root_path: "/project1",
      target_fps: 60,
      interval_ms: 1000,
      group_by: "message",
      top_n_nodes: 8,
      top_n_errors: 5,
      event_tail: 10,
      include_high_frequency: false,
      no_color: false,
      once: false,
      recursive: true,
    });
  });

  it("clamps interval_ms to its valid range via schema", () => {
    expect(() => dashboardArgsSchema.parse({ interval_ms: 100 })).toThrow();
    expect(() => dashboardArgsSchema.parse({ interval_ms: 20_000 })).toThrow();
  });
});

describe("parseArgv", () => {
  it("handles --key value, --key=value, --flag, --no-flag, --json", () => {
    const { raw, json } = parseArgv([
      "--root-path",
      "/foo",
      "--target-fps=120",
      "--once",
      "--no-color",
      "--json",
    ]);
    expect(json).toBe(true);
    expect(raw.root_path).toBe("/foo");
    expect(raw.target_fps).toBe("120");
    expect(raw.once).toBe(true);
    expect(raw.no_color).toBe(true);
  });
});

describe("renderFrame", () => {
  const baseModel: DashboardModel = {
    ts: "17:42:03",
    paused: false,
    args: dashboardArgsSchema.parse({}),
    perf: {
      totalCookMs: 5.0,
      frameBudgetMs: 16.67,
      nodes: [{ path: "/project1/render1", cook_time_ms: 3.1, cook_count: 18234 }],
      status: "ok",
    },
    errors: { total: 0, groups: [], suggestions: [], status: "ok" },
    events: [],
  };

  it("renders perf, errors, events panes", () => {
    const out = renderFrame(baseModel, { color: false, width: 100 });
    expect(out).toContain("PERFORMANCE");
    expect(out).toContain("/project1/render1");
    expect(out).toContain("ERRORS");
    expect(out).toContain("EVENTS");
  });

  it("event_tail=0 suppresses the events pane", () => {
    const model = { ...baseModel, args: { ...baseModel.args, event_tail: 0 } };
    const out = renderFrame(model, { color: false, width: 100 });
    expect(out).not.toContain("EVENTS");
  });

  it("no_color → no ANSI sequences", () => {
    const out = renderFrame(baseModel, { color: false, width: 100 });
    expect(out).not.toContain("\x1b[");
  });

  it("emits ANSI when color=true and there is a status to color", () => {
    const out = renderFrame(baseModel, { color: true, width: 100 });
    expect(out).toContain("\x1b[");
  });

  it("renders the offline banner when bridge is offline", () => {
    const model: DashboardModel = {
      ...baseModel,
      perf: { ...baseModel.perf, status: "offline", error: "TD bridge unreachable" },
    };
    const out = renderFrame(model, { color: false, width: 100 });
    expect(out).toContain("TD offline");
    expect(out).toContain("TD bridge unreachable");
  });
});

describe("collectSnapshot", () => {
  it("populates perf nodes from the mocked bridge, sorted slowest first", async () => {
    server.use(
      http.get(`${TD_BASE}/api/network/:seg/performance`, () =>
        HttpResponse.json({
          ok: true,
          data: {
            nodes: [
              { path: "/project1/a", cook_time_ms: 1.0 },
              { path: "/project1/b", cook_time_ms: 7.0 },
              { path: "/project1/c", cook_time_ms: 3.0 },
            ],
            total_cook_time_ms: 11.0,
          },
        }),
      ),
    );
    const args = dashboardArgsSchema.parse({});
    const model = await collectSnapshot({ ctx: makeCtx(), args, events: [] });
    expect(model.perf.status).toBe("ok");
    expect(model.perf.nodes.map((n) => n.path)).toEqual([
      "/project1/b",
      "/project1/c",
      "/project1/a",
    ]);
  });

  it("marks perf as offline when /api/performance 500s, without throwing", async () => {
    server.use(
      http.get(`${TD_BASE}/api/network/:seg/performance`, () =>
        HttpResponse.json({ ok: false, error: { message: "boom" } }, { status: 500 }),
      ),
    );
    const args = dashboardArgsSchema.parse({});
    const model = await collectSnapshot({ ctx: makeCtx(), args, events: [] });
    expect(model.perf.status).toBe("offline");
  });
});

describe("runDashboard", () => {
  it("--json --once prints a single JSON snapshot and exits 0", async () => {
    const out = makeWriter(false);
    const code = await runDashboard(["--json", "--once", "--root-path", "/project1"], {
      config: makeConfig(),
      makeCtx,
      out,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(out.buf);
    expect(parsed).toHaveProperty("ts");
    expect(parsed).toHaveProperty("perf");
    expect(parsed).toHaveProperty("errors");
    expect(parsed).toHaveProperty("events");
    expect(parsed.perf).toHaveProperty("totalCookMs");
    expect(parsed.perf).toHaveProperty("nodes");
  });

  it("--once on a non-TTY renders one text frame and exits 0", async () => {
    const out = makeWriter(false);
    const code = await runDashboard(["--once"], { config: makeConfig(), makeCtx, out });
    expect(code).toBe(0);
    expect(out.buf).toContain("PERFORMANCE");
    expect(out.buf).toContain("ERRORS");
    // no ANSI on non-TTY default
    expect(out.buf).not.toContain("\x1b[2J");
  });

  it("non-TTY without --once still renders a single frame and resolves cleanly", async () => {
    const out = makeWriter(false);
    const code = await runDashboard([], { config: makeConfig(), makeCtx, out });
    expect(code).toBe(0);
    expect(out.buf).toContain("PERFORMANCE");
  });

  it("renders friendly offline status when /api/performance is down (exit 0 in --once)", async () => {
    server.use(
      http.get(`${TD_BASE}/api/network/:seg/performance`, () =>
        HttpResponse.json({ ok: false, error: { message: "down" } }, { status: 500 }),
      ),
    );
    const out = makeWriter(false);
    const code = await runDashboard(["--once"], { config: makeConfig(), makeCtx, out });
    expect(code).toBe(0);
    expect(out.buf).toContain("TD offline");
  });

  it("event_tail=0 suppresses the EVENTS pane in --once mode", async () => {
    const out = makeWriter(false);
    const code = await runDashboard(["--once", "--event-tail=0"], {
      config: makeConfig(),
      makeCtx,
      out,
    });
    expect(code).toBe(0);
    expect(out.buf).not.toContain("EVENTS");
  });

  it("NO_COLOR env disables ANSI even when stdout is TTY", async () => {
    process.env.NO_COLOR = "1";
    const out = makeWriter(true);
    const code = await runDashboard(["--once"], { config: makeConfig(), makeCtx, out });
    expect(code).toBe(0);
    // The --once path passes color through shouldUseColor → NO_COLOR forces it off.
    // We also separately verify renderFrame is ANSI-free above.
    // Strip the clear-screen sequence (not used in --once) before asserting.
    expect(out.buf.includes("\x1b[")).toBe(false);
  });

  it("--no-color flag disables ANSI", async () => {
    const out = makeWriter(true);
    const code = await runDashboard(["--once", "--no-color"], {
      config: makeConfig(),
      makeCtx,
      out,
    });
    expect(code).toBe(0);
    expect(out.buf.includes("\x1b[")).toBe(false);
  });

  it("rejects bad args with exit code 2", async () => {
    const out = makeWriter(false);
    const code = await runDashboard(["--interval-ms=10"], {
      config: makeConfig(),
      makeCtx,
      out,
    });
    expect(code).toBe(2);
  });
});
