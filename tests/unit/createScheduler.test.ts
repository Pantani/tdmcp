import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import {
  buildSchedulerScript,
  createSchedulerImpl,
  createSchedulerSchema,
} from "../../src/tools/layer2/createScheduler.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

interface Payload {
  parent: string;
  name: string;
  action: string;
  target: string | null;
  param: string | null;
  on_done_value: number;
  expose_controls: boolean;
  callbacks_text: string;
  timers: Array<{
    name: string;
    length: number;
    length_unit: string;
    loop: boolean;
    autostart: boolean;
    segments: Array<{ name: string; length: number }>;
    on_done_cue: string;
  }>;
}

function decodePayload(script: string): Payload {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (b64 === undefined) throw new Error("script did not embed a base64 payload");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
}

function fakeCtx(exec: ReturnType<typeof vi.fn>): ToolContext {
  return { client: { executePythonScript: exec }, logger: silentLogger } as unknown as ToolContext;
}

function scriptArg(exec: ReturnType<typeof vi.fn>): string {
  const script = exec.mock.calls[0]?.[0];
  if (typeof script !== "string")
    throw new Error("executePythonScript was not called with a script");
  return script;
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

const okReport = (over: Record<string, unknown> = {}) =>
  vi.fn(async (_script: string, _capture?: boolean) => ({
    stdout: JSON.stringify({
      comp: "/project1/scheduler",
      callbacks: "/project1/scheduler/callbacks",
      timers: [
        {
          name: "intro",
          path: "/project1/scheduler/intro",
          length: 8,
          length_unit: "seconds",
          loop: false,
          autostart: true,
          segment_count: 0,
        },
      ],
      controls: ["Active"],
      warnings: [],
      ...over,
    }),
  }));

describe("createScheduler schema", () => {
  it("applies top-level defaults", () => {
    const args = createSchedulerSchema.parse({ timers: [{ name: "t1" }] });
    expect(args.name).toBe("scheduler");
    expect(args.parent_path).toBe("/project1");
    expect(args.action).toBe("cue");
    expect(args.expose_controls).toBe(true);
    expect(args.on_done_value).toBe(1);
  });

  it("applies timer + segment defaults", () => {
    const args = createSchedulerSchema.parse({
      timers: [{ name: "t1", segments: [{ name: "a" }] }],
    });
    const t = args.timers[0];
    expect(t?.length).toBe(8);
    expect(t?.length_unit).toBe("seconds");
    expect(t?.loop).toBe(false);
    expect(t?.autostart).toBe(true);
    expect(t?.segments[0]?.length).toBe(4);
  });

  it("requires at least one timer", () => {
    expect(() => createSchedulerSchema.parse({ timers: [] })).toThrow();
  });

  it("rejects an unknown action", () => {
    expect(() =>
      createSchedulerSchema.parse({ timers: [{ name: "t1" }], action: "foo" }),
    ).toThrow();
  });

  it("rejects an unknown length_unit", () => {
    expect(() =>
      createSchedulerSchema.parse({ timers: [{ name: "t1", length_unit: "frames" }] }),
    ).toThrow();
  });
});

describe("buildSchedulerScript", () => {
  const script = buildSchedulerScript({
    parent: "/project1",
    name: "scheduler",
    action: "cue",
    target: "/project1/viz",
    param: null,
    on_done_value: 1,
    expose_controls: true,
    callbacks_text: "CB",
    timers: [
      {
        name: "intro",
        length: 8,
        length_unit: "seconds",
        loop: false,
        autostart: true,
        segments: [{ name: "a", length: 2 }],
        on_done_cue: "intro",
      },
      {
        name: "drop",
        length: 16,
        length_unit: "beats",
        loop: true,
        autostart: false,
        segments: [],
        on_done_cue: "drop",
      },
    ],
  });

  it("round-trips the payload fields", () => {
    const p = decodePayload(script);
    expect(p.parent).toBe("/project1");
    expect(p.name).toBe("scheduler");
    expect(p.action).toBe("cue");
    expect(p.target).toBe("/project1/viz");
    expect(p.on_done_value).toBe(1);
    expect(p.timers).toHaveLength(2);
    expect(p.timers[0]).toMatchObject({
      name: "intro",
      length: 8,
      length_unit: "seconds",
      loop: false,
      autostart: true,
      on_done_cue: "intro",
    });
    expect(p.timers[0]?.segments[0]).toMatchObject({ name: "a", length: 2 });
    expect(p.timers[1]).toMatchObject({
      name: "drop",
      length_unit: "beats",
      loop: true,
      autostart: false,
    });
  });

  it("creates the expected TD optypes", () => {
    expect(script).toContain("td.containerCOMP");
    expect(script).toContain("td.timerCHOP");
    expect(script).toContain("td.textDAT");
    expect(script).toContain("td.tableDAT");
  });

  it("embeds callbacks markers and config-from-storage contract", () => {
    expect(script).toContain("tdmcp_sched_cfg");
    // The Callbacks DAT text is the payload — assert via the impl test below; here just check the
    // script wires the Callbacks DAT par via the candidate-list idiom.
    expect(script).toContain('"callbacks"');
    expect(script).toContain('"callbackdat"');
  });

  it("includes the Length Units candidate handling and Cycle / Cycle Limit branch", () => {
    expect(script).toContain("lengthunits");
    expect(script).toContain("cycle");
    expect(script).toContain("cyclelimit");
  });
});

describe("createSchedulerImpl — guards (no bridge call)", () => {
  it("errors when action is 'cue' and target is missing", async () => {
    const exec = okReport();
    const result = await createSchedulerImpl(fakeCtx(exec), {
      timers: [
        {
          name: "t1",
          length: 8,
          length_unit: "seconds",
          segments: [],
          loop: false,
          autostart: true,
        },
      ],
      name: "scheduler",
      parent_path: "/project1",
      action: "cue",
      on_done_value: 1,
      expose_controls: true,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("target");
    expect(exec).not.toHaveBeenCalled();
  });

  it("errors when action is 'param' with target but no param", async () => {
    const exec = okReport();
    const result = await createSchedulerImpl(fakeCtx(exec), {
      timers: [
        {
          name: "t1",
          length: 8,
          length_unit: "seconds",
          segments: [],
          loop: false,
          autostart: true,
        },
      ],
      name: "scheduler",
      parent_path: "/project1",
      action: "param",
      target: "/project1/viz",
      on_done_value: 1,
      expose_controls: true,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("param");
    expect(exec).not.toHaveBeenCalled();
  });

  it("errors on duplicate timer names", async () => {
    const exec = okReport();
    const result = await createSchedulerImpl(fakeCtx(exec), {
      timers: [
        {
          name: "t1",
          length: 8,
          length_unit: "seconds",
          segments: [],
          loop: false,
          autostart: true,
        },
        {
          name: "t1",
          length: 4,
          length_unit: "seconds",
          segments: [],
          loop: false,
          autostart: true,
        },
      ],
      name: "scheduler",
      parent_path: "/project1",
      action: "script",
      on_done_value: 1,
      expose_controls: true,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/unique/i);
    expect(exec).not.toHaveBeenCalled();
  });

  it("allows action 'script' without a target", async () => {
    const exec = okReport();
    const result = await createSchedulerImpl(fakeCtx(exec), {
      timers: [
        {
          name: "t1",
          length: 8,
          length_unit: "seconds",
          segments: [],
          loop: false,
          autostart: true,
        },
      ],
      name: "scheduler",
      parent_path: "/project1",
      action: "script",
      on_done_value: 1,
      expose_controls: true,
    });
    expect(result.isError).toBeFalsy();
    expect(exec).toHaveBeenCalledTimes(1);
  });
});

describe("createSchedulerImpl — callbacks template + payload", () => {
  it("embeds onDone/onSegmentEnter and cue-reuse markers into the deployed Callbacks DAT text", async () => {
    const exec = okReport();
    await createSchedulerImpl(fakeCtx(exec), {
      timers: [
        {
          name: "intro",
          length: 8,
          length_unit: "seconds",
          segments: [],
          loop: false,
          autostart: true,
        },
      ],
      name: "scheduler",
      parent_path: "/project1",
      action: "cue",
      target: "/project1/viz",
      on_done_value: 1,
      expose_controls: true,
    });
    const payload = decodePayload(scriptArg(exec));
    expect(payload.callbacks_text).toContain("def onDone(");
    expect(payload.callbacks_text).toContain("def onSegmentEnter(");
    expect(payload.callbacks_text).toContain("tdmcp_sched_cfg");
    expect(payload.callbacks_text).toContain("tdmcp_cues");
    // on_done_cue defaults to the timer name in the payload.
    expect(payload.timers[0]?.on_done_cue).toBe("intro");
  });

  it("passes captureStdout=true to executePythonScript", async () => {
    const exec = okReport();
    await createSchedulerImpl(fakeCtx(exec), {
      timers: [
        {
          name: "t1",
          length: 8,
          length_unit: "seconds",
          segments: [],
          loop: false,
          autostart: true,
        },
      ],
      name: "scheduler",
      parent_path: "/project1",
      action: "script",
      on_done_value: 1,
      expose_controls: true,
    });
    expect(exec.mock.calls[0]?.[1]).toBe(true);
  });
});

describe("createSchedulerImpl — result shape", () => {
  it("summarises comp, timer count and UNVERIFIED probe note on success", async () => {
    const exec = okReport();
    const result = await createSchedulerImpl(fakeCtx(exec), {
      timers: [
        {
          name: "intro",
          length: 8,
          length_unit: "seconds",
          segments: [],
          loop: false,
          autostart: true,
        },
      ],
      name: "scheduler",
      parent_path: "/project1",
      action: "cue",
      target: "/project1/viz",
      on_done_value: 1,
      expose_controls: true,
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("/project1/scheduler");
    expect(text).toContain("1 timer(s)");
    expect(text).toContain("UNVERIFIED");
    expect(text).toContain("/project1/viz");
  });

  it("returns an error result when report.fatal is set", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        comp: "/project1",
        callbacks: "",
        timers: [],
        controls: [],
        warnings: [],
        fatal: "COMP not found: /project1",
      }),
    }));
    const result = await createSchedulerImpl(fakeCtx(exec), {
      timers: [
        {
          name: "t1",
          length: 8,
          length_unit: "seconds",
          segments: [],
          loop: false,
          autostart: true,
        },
      ],
      name: "scheduler",
      parent_path: "/project1",
      action: "script",
      on_done_value: 1,
      expose_controls: true,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("COMP not found");
  });

  it("surfaces the warning count in the summary when warnings are present", async () => {
    const exec = okReport({
      warnings: ["Length Units (beats) UNVERIFIED on timer t1 - check par token live."],
    });
    const result = await createSchedulerImpl(fakeCtx(exec), {
      timers: [
        { name: "t1", length: 8, length_unit: "beats", segments: [], loop: false, autostart: true },
      ],
      name: "scheduler",
      parent_path: "/project1",
      action: "script",
      on_done_value: 1,
      expose_controls: true,
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toMatch(/1 warning\(s\)/);
  });

  it("returns a friendly error (not throw) when the bridge connection fails", async () => {
    const exec = vi.fn(async () => {
      throw Object.assign(new Error("bridge down"), { name: "TdConnectionError" });
    });
    const result = await createSchedulerImpl(fakeCtx(exec), {
      timers: [
        {
          name: "t1",
          length: 8,
          length_unit: "seconds",
          segments: [],
          loop: false,
          autostart: true,
        },
      ],
      name: "scheduler",
      parent_path: "/project1",
      action: "script",
      on_done_value: 1,
      expose_controls: true,
    });
    expect(result.isError).toBe(true);
  });
});
