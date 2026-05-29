import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import {
  buildBeatGridSequencerScript,
  createBeatGridSequencerImpl,
  createBeatGridSequencerSchema,
} from "../../src/tools/layer2/createBeatGridSequencer.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

interface Payload {
  name: string;
  parent: string;
  target: string;
  steps: number;
  action: string;
  param: string;
  pattern: number[];
  bpm_source: string | null;
  dispatch_text: string;
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
      comp: "/project1/beat_grid",
      beat: "/project1/beat_grid/beat",
      table: "/project1/beat_grid/step_table",
      dispatch: "/project1/beat_grid/dispatch",
      controls: ["Active", "Steps"],
      steps: 16,
      action: "param",
      warnings: [],
      ...over,
    }),
  }));

/** Parse partial args through the schema (applying defaults), then run the tool. */
function run(args: Parameters<typeof createBeatGridSequencerSchema.parse>[0]) {
  const exec = okReport();
  return {
    exec,
    promise: createBeatGridSequencerImpl(fakeCtx(exec), createBeatGridSequencerSchema.parse(args)),
  };
}

// ── Schema ────────────────────────────────────────────────────────────────────

describe("createBeatGridSequencer schema", () => {
  it("applies defaults: name 'beat_grid', parent '/project1', steps 16, action 'param', pattern []", () => {
    const args = createBeatGridSequencerSchema.parse({ target: "/project1/viz" });
    expect(args.name).toBe("beat_grid");
    expect(args.parent_path).toBe("/project1");
    expect(args.steps).toBe(16);
    expect(args.action).toBe("param");
    expect(args.pattern).toEqual([]);
  });

  it("requires target (no default)", () => {
    expect(() => createBeatGridSequencerSchema.parse({})).toThrow();
  });

  it("rejects steps < 1", () => {
    expect(() =>
      createBeatGridSequencerSchema.parse({ target: "/project1/viz", steps: 0 }),
    ).toThrow();
  });

  it("rejects steps > 64", () => {
    expect(() =>
      createBeatGridSequencerSchema.parse({ target: "/project1/viz", steps: 65 }),
    ).toThrow();
  });

  it("rejects an unknown action value", () => {
    expect(() =>
      createBeatGridSequencerSchema.parse({ target: "/project1/viz", action: "trigger" }),
    ).toThrow();
  });
});

// ── buildBeatGridSequencerScript ──────────────────────────────────────────────

describe("buildBeatGridSequencerScript", () => {
  const script = buildBeatGridSequencerScript({
    name: "beat_grid",
    parent: "/project1",
    target: "/project1/viz",
    steps: 16,
    action: "param",
    param: "Brightness",
    pattern: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
    bpm_source: null,
    dispatch_text: "DISPATCH",
  });

  it("embeds name, parent, target, steps, action, param and pattern in the payload", () => {
    const payload = decodePayload(script);
    expect(payload.name).toBe("beat_grid");
    expect(payload.parent).toBe("/project1");
    expect(payload.target).toBe("/project1/viz");
    expect(payload.steps).toBe(16);
    expect(payload.action).toBe("param");
    expect(payload.param).toBe("Brightness");
    expect(payload.pattern).toHaveLength(16);
    expect(payload.pattern[0]).toBe(1);
    expect(payload.bpm_source).toBeNull();
  });

  it("creates a Beat CHOP and a CHOP Execute DAT watching the count channel", () => {
    expect(script).toContain("td.beatCHOP");
    expect(script).toContain("td.chopexecuteDAT");
    expect(script).toContain('_disp.par.channel = "count"');
    expect(script).toContain("_disp.par.valuechange = True");
  });

  it("creates a Table DAT called step_table", () => {
    expect(script).toContain("td.tableDAT");
    expect(script).toContain('"step_table"');
    expect(script).toContain("_tbl.setSize(1, _n)");
  });

  it("exposes Active and Steps controls", () => {
    expect(script).toContain('appendToggle("Active")');
    expect(script).toContain('appendInt("Steps")');
  });

  it("deploys the dispatch_text into the dispatch DAT", () => {
    expect(script).toContain("_disp.text = _p");
  });
});

// ── Dispatch callback substitution ───────────────────────────────────────────

describe("createBeatGridSequencerImpl — dispatch substitution", () => {
  it("bakes target, action, and param into the dispatch callback with no placeholders", async () => {
    const { exec, promise } = run({
      target: "/project1/viz",
      action: "param",
      param: "Brightness",
    });
    await promise;
    const dispatchText = decodePayload(scriptArg(exec)).dispatch_text;
    expect(dispatchText).not.toContain("__TARGET__");
    expect(dispatchText).not.toContain("__ACTION__");
    expect(dispatchText).not.toContain("__PARAM__");
    expect(dispatchText).toContain("/project1/viz");
    expect(dispatchText).toContain("param");
    expect(dispatchText).toContain("Brightness");
  });

  it("dispatches via cue recall when action=cue, referencing tdmcp_cues storage", async () => {
    const { exec, promise } = run({ target: "/project1/viz", action: "cue" });
    await promise;
    const dispatchText = decodePayload(scriptArg(exec)).dispatch_text;
    expect(dispatchText).toContain("tdmcp_cues");
    expect(dispatchText).toContain("cue");
  });

  it("uses count % steps for the step index lookup", async () => {
    const { exec, promise } = run({ target: "/project1/viz", action: "param", param: "Hue" });
    await promise;
    const dispatchText = decodePayload(scriptArg(exec)).dispatch_text;
    expect(dispatchText).toContain("step_idx = int(val) % n_steps");
  });

  it("reads the pattern value from the Table DAT by step index", async () => {
    const { exec, promise } = run({ target: "/project1/viz", action: "param", param: "Hue" });
    await promise;
    const dispatchText = decodePayload(scriptArg(exec)).dispatch_text;
    expect(dispatchText).toContain("step_table");
    expect(dispatchText).toContain("tbl[0, step_idx]");
  });

  it("embeds the provided pattern into the payload", async () => {
    const pattern = [1, 0, 1, 0, 1, 0, 1, 0];
    const { exec, promise } = run({
      target: "/project1/viz",
      action: "param",
      param: "Hue",
      steps: 8,
      pattern,
    });
    await promise;
    const payload = decodePayload(scriptArg(exec));
    expect(payload.pattern).toEqual(pattern);
  });
});

// ── Result shape ──────────────────────────────────────────────────────────────

describe("createBeatGridSequencerImpl — result shape", () => {
  it("summarises comp, steps, action, target, and UNVERIFIED note on success", async () => {
    const exec = okReport();
    const result = await createBeatGridSequencerImpl(fakeCtx(exec), {
      name: "beat_grid",
      parent_path: "/project1",
      target: "/project1/viz",
      steps: 16,
      action: "param",
      param: "Brightness",
      pattern: [],
      bpm_source: undefined,
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("/project1/beat_grid");
    expect(text).toContain("16 steps");
    expect(text).toContain("/project1/viz");
    expect(text).toContain("UNVERIFIED");
  });

  it("includes the param name in the action description", async () => {
    const exec = okReport();
    const result = await createBeatGridSequencerImpl(fakeCtx(exec), {
      name: "beat_grid",
      parent_path: "/project1",
      target: "/project1/viz",
      steps: 16,
      action: "param",
      param: "Brightness",
      pattern: [],
      bpm_source: undefined,
    });
    expect(textOf(result)).toContain("Brightness");
  });

  it("notes the warning count in the summary when warnings are present", async () => {
    const exec = okReport({ warnings: ["Could not fully wire the CHOP Execute dispatch DAT."] });
    const result = await createBeatGridSequencerImpl(fakeCtx(exec), {
      name: "beat_grid",
      parent_path: "/project1",
      target: "/project1/viz",
      steps: 16,
      action: "param",
      param: "Brightness",
      pattern: [],
      bpm_source: undefined,
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toMatch(/1 warning\(s\)/);
  });

  it("returns isError when report.fatal is set — does not throw", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        comp: "/project1",
        beat: "",
        table: "",
        dispatch: "",
        controls: [],
        steps: 16,
        action: "param",
        warnings: [],
        fatal: "COMP not found: /project1/missing",
      }),
    }));
    const result = await createBeatGridSequencerImpl(fakeCtx(exec), {
      name: "beat_grid",
      parent_path: "/project1",
      target: "/project1/missing",
      steps: 16,
      action: "param",
      param: "Brightness",
      pattern: [],
      bpm_source: undefined,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("COMP not found");
  });

  it("returns isError (no throw) when action=param but param is missing", async () => {
    const exec = okReport();
    // Bypass schema to call impl directly without param.
    const result = await createBeatGridSequencerImpl(fakeCtx(exec), {
      name: "beat_grid",
      parent_path: "/project1",
      target: "/project1/viz",
      steps: 16,
      action: "param",
      param: undefined,
      pattern: [],
      bpm_source: undefined,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("param");
  });

  it("passes the script to executePythonScript with captureStdout=true", async () => {
    const exec = okReport();
    await createBeatGridSequencerImpl(fakeCtx(exec), {
      name: "beat_grid",
      parent_path: "/project1",
      target: "/project1/viz",
      steps: 16,
      action: "param",
      param: "Brightness",
      pattern: [],
      bpm_source: undefined,
    });
    expect(exec.mock.calls[0]?.[1]).toBe(true);
  });

  it("cue action: does not throw and returns success without a param field", async () => {
    const exec = okReport({ action: "cue" });
    const result = await createBeatGridSequencerImpl(fakeCtx(exec), {
      name: "beat_grid",
      parent_path: "/project1",
      target: "/project1/viz",
      steps: 8,
      action: "cue",
      param: undefined,
      pattern: [1, 0, 1, 0, 1, 0, 1, 0],
      bpm_source: undefined,
    });
    expect(result.isError).toBeFalsy();
  });
});
