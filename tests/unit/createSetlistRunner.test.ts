import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import {
  buildSetlistRunnerScript,
  createSetlistRunnerImpl,
  createSetlistRunnerSchema,
} from "../../src/tools/layer1/createSetlistRunner.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

interface Payload {
  parent_path: string;
  name: string;
  rows: Array<{
    source: string;
    duration_seconds: number;
    transition_seconds: number;
    label: string;
  }>;
  loop: boolean;
  autostart: boolean;
  show_hud: boolean;
  default_transition: number;
  engine_source: string;
  param_engine_source: string;
}

function decodePayload(script: string): Payload {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (b64 === undefined) throw new Error("no base64 payload found");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as Payload;
}

function fakeCtx(exec: ReturnType<typeof vi.fn>): ToolContext {
  return {
    client: { executePythonScript: exec },
    logger: silentLogger,
  } as unknown as ToolContext;
}

function scriptArg(exec: ReturnType<typeof vi.fn>): string {
  const s = exec.mock.calls[0]?.[0];
  if (typeof s !== "string") throw new Error("executePythonScript not called with a string");
  return s;
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

const DEFAULT_ARGS = {
  rows: [
    { source: "/project1/a", duration_seconds: 30 },
    { source: "/project1/b", duration_seconds: 60, transition_seconds: 1.5 },
    { source: "/project1/c", duration_seconds: 20 },
  ],
  sources_map: {},
  default_transition: 0.5,
  loop: true,
  autostart: true,
  show_hud: true,
  name: "setlist",
  parent_path: "/project1",
};

function happyReport(overrides: Partial<{ warnings: string[]; out_top: string }> = {}) {
  return JSON.stringify({
    comp: "/project1/setlist",
    switch: "/project1/setlist/switch",
    timer: "/project1/setlist/timer",
    engine: "/project1/setlist/engine",
    param_engine: "/project1/setlist/param_engine",
    out_top: overrides.out_top ?? "/project1/setlist/out",
    hud: "/project1/setlist/hud",
    rows: DEFAULT_ARGS.rows.map((r) => ({
      source: r.source,
      duration_seconds: r.duration_seconds,
      transition_seconds: r.transition_seconds ?? 0.5,
      label: r.source.split("/").pop(),
    })),
    controls: ["Play", "Row", "Skip", "Prev", "Loop", "Defaulttransition"],
    warnings: overrides.warnings ?? [],
  });
}

describe("buildSetlistRunnerScript (pure payload)", () => {
  it("encodes rows + flags into the base64 payload", () => {
    const script = buildSetlistRunnerScript({
      parent_path: "/project1",
      name: "setlist",
      rows: [
        { source: "/a", duration_seconds: 30, transition_seconds: 0.5, label: "a" },
        { source: "/b", duration_seconds: 60, transition_seconds: 1.5, label: "b" },
      ],
      loop: true,
      autostart: true,
      show_hud: true,
      default_transition: 0.5,
      engine_source: "# engine",
      param_engine_source: "# param engine",
    });
    const payload = decodePayload(script);
    expect(payload.rows).toHaveLength(2);
    expect(payload.rows[0]?.source).toBe("/a");
    expect(payload.rows[1]?.transition_seconds).toBe(1.5);
    expect(payload.loop).toBe(true);
    expect(payload.show_hud).toBe(true);
    expect(payload.engine_source).toContain("# engine");
  });

  it("script template references all required operator types", () => {
    const script = buildSetlistRunnerScript({
      parent_path: "/project1",
      name: "setlist",
      rows: [],
      loop: true,
      autostart: true,
      show_hud: true,
      default_transition: 0.5,
      engine_source: "",
      param_engine_source: "",
    });
    expect(script).toContain("switchTOP");
    expect(script).toContain("crossTOP");
    expect(script).toContain("timerCHOP");
    expect(script).toContain("chopexecuteDAT");
    expect(script).toContain("textTOP");
    expect(script).toContain("nullTOP");
    expect(script).toContain("compositeTOP");
    expect(script).toContain("selectTOP");
    expect(script).toContain("parameterexecuteDAT");
    expect(script).toContain("print(json.dumps(report))");
  });

  it("embeds a param engine source that wires Play/Row/Skip/Prev to timer + switch", async () => {
    const exec = vi.fn(async () => ({ stdout: happyReport() }));
    await createSetlistRunnerImpl(fakeCtx(exec), DEFAULT_ARGS);
    const payload = decodePayload(scriptArg(exec));
    expect(payload.param_engine_source).toContain("def onValueChange");
    expect(payload.param_engine_source).toContain("def onPulse");
    // reacts to all four live params
    expect(payload.param_engine_source).toContain('"Play"');
    expect(payload.param_engine_source).toContain('"Row"');
    expect(payload.param_engine_source).toContain('"Skip"');
    expect(payload.param_engine_source).toContain('"Prev"');
    // actually drives the timer + switch (not a no-op stub)
    expect(payload.param_engine_source).toContain("tm.par.play");
    expect(payload.param_engine_source).toContain("tm.par.start.pulse()");
    expect(payload.param_engine_source).toContain("sw.par.index");
  });
});

describe("createSetlistRunnerImpl — happy path", () => {
  it("posts exactly one executePythonScript with a 3-row payload", async () => {
    const exec = vi.fn(async () => ({ stdout: happyReport() }));
    const result = await createSetlistRunnerImpl(fakeCtx(exec), DEFAULT_ARGS);
    expect(result.isError).toBeFalsy();
    expect(exec).toHaveBeenCalledTimes(1);
    const payload = decodePayload(scriptArg(exec));
    expect(payload.rows).toHaveLength(3);
    expect(payload.rows[0]?.duration_seconds).toBe(30);
    expect(payload.rows[1]?.transition_seconds).toBe(1.5);
    // default_transition applies to rows that omit transition_seconds
    expect(payload.rows[0]?.transition_seconds).toBe(0.5);
    expect(payload.rows[2]?.transition_seconds).toBe(0.5);
    expect(payload.default_transition).toBe(0.5);
    expect(payload.loop).toBe(true);
    expect(payload.show_hud).toBe(true);
  });

  it("summary mentions row count, loop, and output path", async () => {
    const exec = vi.fn(async () => ({ stdout: happyReport() }));
    const result = await createSetlistRunnerImpl(fakeCtx(exec), DEFAULT_ARGS);
    const text = textOf(result);
    expect(text).toContain("3 rows");
    expect(text).toContain("loop");
    expect(text).toContain("/project1/setlist/out");
  });

  it("resolves sources_map logical names to real TOP paths", async () => {
    const exec = vi.fn(async () => ({ stdout: happyReport() }));
    await createSetlistRunnerImpl(fakeCtx(exec), {
      ...DEFAULT_ARGS,
      rows: [{ source: "actA", duration_seconds: 30 }],
      sources_map: { actA: "/project1/moviefilein1" },
    });
    const payload = decodePayload(scriptArg(exec));
    expect(payload.rows[0]?.source).toBe("/project1/moviefilein1");
  });

  it("derives label from source basename when omitted", async () => {
    const exec = vi.fn(async () => ({ stdout: happyReport() }));
    await createSetlistRunnerImpl(fakeCtx(exec), {
      ...DEFAULT_ARGS,
      rows: [{ source: "/project1/moviefilein7", duration_seconds: 5 }],
    });
    const payload = decodePayload(scriptArg(exec));
    expect(payload.rows[0]?.label).toBe("moviefilein7");
  });

  it("includes warning count in summary when warnings present", async () => {
    const exec = vi.fn(async () => ({
      stdout: happyReport({ warnings: ["selectTOP[0].par.top failed: missing"] }),
    }));
    const result = await createSetlistRunnerImpl(fakeCtx(exec), DEFAULT_ARGS);
    expect(textOf(result)).toContain("1 warning(s)");
  });
});

describe("createSetlistRunnerSchema defaults", () => {
  it("applies all documented defaults", () => {
    const parsed = createSetlistRunnerSchema.parse({
      rows: [{ source: "/a" }],
    });
    expect(parsed.default_transition).toBe(0.5);
    expect(parsed.loop).toBe(true);
    expect(parsed.autostart).toBe(true);
    expect(parsed.show_hud).toBe(true);
    expect(parsed.name).toBe("setlist");
    expect(parsed.parent_path).toBe("/project1");
    expect(parsed.rows[0]?.duration_seconds).toBe(30);
  });

  it("rejects empty rows array", () => {
    expect(() => createSetlistRunnerSchema.parse({ rows: [] })).toThrow();
  });

  it("rejects non-positive duration_seconds", () => {
    expect(() =>
      createSetlistRunnerSchema.parse({ rows: [{ source: "/a", duration_seconds: 0 }] }),
    ).toThrow();
  });

  it("coerces string numbers", () => {
    const parsed = createSetlistRunnerSchema.parse({
      rows: [{ source: "/a", duration_seconds: "45", transition_seconds: "2" }],
      default_transition: "0.75",
    });
    expect(parsed.rows[0]?.duration_seconds).toBe(45);
    expect(parsed.rows[0]?.transition_seconds).toBe(2);
    expect(parsed.default_transition).toBe(0.75);
  });
});

describe("createSetlistRunnerImpl — fatal", () => {
  it("returns isError:true when bridge reports fatal", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        comp: "",
        switch: "",
        timer: "",
        engine: "",
        out_top: "",
        rows: [],
        controls: [],
        warnings: [],
        fatal: "Parent COMP not found: /missing",
      }),
    }));
    const result = await createSetlistRunnerImpl(fakeCtx(exec), {
      ...DEFAULT_ARGS,
      parent_path: "/missing",
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Setlist runner build failed");
    expect(textOf(result)).toContain("Parent COMP not found");
  });
});

describe("createSetlistRunnerImpl — TD offline", () => {
  it("returns isError:true and does not throw when bridge is unreachable", async () => {
    const exec = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const result = await createSetlistRunnerImpl(fakeCtx(exec), DEFAULT_ARGS);
    expect(result.isError).toBe(true);
  });
});
