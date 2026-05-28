import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import {
  buildCueSequencerScript,
  createCueSequencerImpl,
  createCueSequencerSchema,
} from "../../src/tools/layer2/createCueSequencer.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

interface Payload {
  target: string;
  name: string;
  parent: string;
  steps: Array<{ cue: string; bars: number }>;
  loop: boolean;
  quantize: string;
  morph_seconds: number;
  engine_text: string;
  morph_hook: string;
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
      comp: "/project1/cue_seq",
      beat: "/project1/cue_seq/beat",
      engine: "/project1/cue_seq/engine",
      steps: [
        { cue: "intro", bars: 4 },
        { cue: "drop", bars: 8 },
      ],
      controls: ["Active", "Step", "Barsperstep"],
      warnings: [],
      ...over,
    }),
  }));

/** Parse partial args through the schema (applying defaults), then run the tool. */
function run(args: Parameters<typeof createCueSequencerSchema.parse>[0]) {
  const exec = okReport();
  return {
    exec,
    promise: createCueSequencerImpl(fakeCtx(exec), createCueSequencerSchema.parse(args)),
  };
}

describe("createCueSequencer schema", () => {
  it("applies defaults: loop true, quantize 'bar', morph_seconds 0, name 'cue_seq'", () => {
    const args = createCueSequencerSchema.parse({ steps: [{ cue: "a" }] });
    expect(args.loop).toBe(true);
    expect(args.quantize).toBe("bar");
    expect(args.morph_seconds).toBe(0);
    expect(args.name).toBe("cue_seq");
    expect(args.target).toBe("/project1");
    // A step with no explicit bars defaults to 4.
    expect(args.steps[0]?.bars).toBe(4);
  });

  it("requires at least one step", () => {
    expect(() => createCueSequencerSchema.parse({ steps: [] })).toThrow();
  });

  it("rejects an unknown quantize value", () => {
    expect(() =>
      createCueSequencerSchema.parse({ steps: [{ cue: "a" }], quantize: "half" }),
    ).toThrow();
  });
});

describe("buildCueSequencerScript", () => {
  const script = buildCueSequencerScript({
    target: "/project1/viz",
    name: "cue_seq",
    parent: "/project1",
    steps: [
      { cue: "intro", bars: 4 },
      { cue: "drop", bars: 8 },
    ],
    loop: true,
    quantize: "bar",
    morph_seconds: 0,
    engine_text: "ENGINE",
    morph_hook: "HOOK",
  });

  it("embeds target, name, parent, ordered steps, loop, quantize and morph_seconds in the payload", () => {
    const payload = decodePayload(script);
    expect(payload.target).toBe("/project1/viz");
    expect(payload.name).toBe("cue_seq");
    expect(payload.parent).toBe("/project1");
    expect(payload.loop).toBe(true);
    expect(payload.quantize).toBe("bar");
    expect(payload.morph_seconds).toBe(0);
    expect(payload.steps).toHaveLength(2);
    expect(payload.steps[0]).toMatchObject({ cue: "intro", bars: 4 });
    expect(payload.steps[1]).toMatchObject({ cue: "drop", bars: 8 });
  });

  it("builds a Beat CHOP + CHOP Execute DAT watching the cumulative count channel", () => {
    expect(script).toContain("td.beatCHOP");
    expect(script).toContain("td.chopexecuteDAT");
    expect(script).toContain('_eng.par.channel = "count"');
    expect(script).toContain("_eng.par.valuechange = True");
  });

  it("exposes the Active / Step / Barsperstep live controls", () => {
    expect(script).toContain('appendToggle("Active")');
    expect(script).toContain('appendInt("Step")');
    expect(script).toContain('appendInt("Barsperstep")');
  });

  it("stores the ordered step list and resets the runtime index/target state", () => {
    expect(script).toContain('_seq.store("tdmcp_seq_steps", _p["steps"])');
    expect(script).toContain('_seq.store("tdmcp_seq_index", 0)');
    // The boundary is an accumulated absolute beat target seeded by the engine on its first
    // beat (None here) — replacing the old single-step-length block counter so variable step
    // lengths fire at the right cumulative beats.
    expect(script).toContain('_seq.store("tdmcp_seq_target", None)');
    expect(script).not.toContain("tdmcp_seq_block");
  });

  it("wires the target's cue_morph hook only when a morph time is set", () => {
    expect(script).toContain('if float(_p["morph_seconds"]) > 0:');
    expect(script).toContain('_tgt.create(td.executeDAT, "cue_morph")');
  });
});

describe("createCueSequencerImpl — engine substitution", () => {
  it("substitutes target / quantize / loop / morph into the deployed engine callback", async () => {
    const { exec, promise } = run({
      target: "/project1/viz",
      steps: [{ cue: "intro", bars: 4 }],
      quantize: "bar",
      loop: true,
      morph_seconds: 0,
    });
    await promise;
    const engineText = decodePayload(scriptArg(exec)).engine_text;
    // No placeholders survive into the deployed callback.
    expect(engineText).not.toContain("__TARGET__");
    expect(engineText).not.toContain("__QUANT__");
    expect(engineText).not.toContain("__LOOP__");
    expect(engineText).not.toContain("__MORPH__");
    // The target path is baked in, and it recalls from manage_cue's storage.
    expect(engineText).toContain("/project1/viz");
    expect(engineText).toContain("tdmcp_cues");
    // The step-boundary detector advances an index in the engine COMP's storage, gated by an
    // accumulated absolute beat target (each advance adds the NEXT step's OWN length) so
    // variable step lengths fire at the right cumulative beats — not floor(count / step_len).
    expect(engineText).toContain("tdmcp_seq_index");
    expect(engineText).toContain("tdmcp_seq_target");
    expect(engineText).toContain("_len_beats");
    expect(engineText).not.toContain("step_len");
    // It honours a live Step change (cue-jump): reads seq.par.Step and syncs the internal
    // index from it before advancing, so a performer/dashboard move isn't overwritten.
    expect(engineText).toContain("getattr(seq.par, 'Step', None)");
    expect(engineText).toContain("sp.eval()");
    expect(engineText).toContain("jumped");
    expect(engineText).toContain("stepval != idx");
  });

  it("bakes 'stop' (not 'loop') into the engine when loop is false", async () => {
    const { exec, promise } = run({
      target: "/project1/viz",
      steps: [{ cue: "a", bars: 2 }],
      loop: false,
    });
    await promise;
    const engineText = decodePayload(scriptArg(exec)).engine_text;
    // The __LOOP__ marker is fully substituted by the baked literal, so the wrap-around
    // guard reads "'stop' == 'loop'" (false) — the timeline stops instead of looping.
    expect(engineText).not.toContain("__LOOP__");
    expect(engineText).toContain("'stop' == 'loop'");
  });

  it("carries the morph seconds into the engine for a morphing sequencer", async () => {
    const { exec, promise } = run({
      target: "/project1/viz",
      steps: [{ cue: "a", bars: 4 }],
      morph_seconds: 1.5,
    });
    await promise;
    const payload = decodePayload(scriptArg(exec));
    expect(payload.morph_seconds).toBe(1.5);
    expect(payload.engine_text).toContain("dur = float('1.5')");
  });
});

describe("createCueSequencerImpl — result shape", () => {
  it("summarises the engine comp, step count, quantize unit and target on success", async () => {
    const exec = okReport();
    const result = await createCueSequencerImpl(fakeCtx(exec), {
      target: "/project1/viz",
      steps: [
        { cue: "intro", bars: 4 },
        { cue: "drop", bars: 8 },
      ],
      loop: true,
      quantize: "bar",
      morph_seconds: 0,
      name: "cue_seq",
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("/project1/cue_seq");
    expect(text).toContain("2 step(s)");
    expect(text).toContain("every bar");
    expect(text).toContain("/project1/viz");
  });

  it("notes the morph time in the summary when morphing", async () => {
    const exec = okReport();
    const result = await createCueSequencerImpl(fakeCtx(exec), {
      target: "/project1/viz",
      steps: [{ cue: "a", bars: 4 }],
      loop: true,
      quantize: "beat",
      morph_seconds: 2,
      name: "cue_seq",
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("every beat");
    expect(text).toContain("morph 2s");
  });

  it("returns an error result when report.fatal is set", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        comp: "/project1",
        steps: [{ cue: "a", bars: 4 }],
        controls: [],
        warnings: [],
        fatal: "COMP not found: /project1",
      }),
    }));
    const result = await createCueSequencerImpl(fakeCtx(exec), {
      target: "/project1",
      steps: [{ cue: "a", bars: 4 }],
      loop: true,
      quantize: "bar",
      morph_seconds: 0,
      name: "cue_seq",
      parent_path: "/project1",
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("COMP not found");
  });

  it("surfaces the warning count in the summary when warnings are present", async () => {
    const exec = okReport({ warnings: ["Could not fully wire the CHOP Execute engine."] });
    const result = await createCueSequencerImpl(fakeCtx(exec), {
      target: "/project1/viz",
      steps: [{ cue: "a", bars: 4 }],
      loop: true,
      quantize: "bar",
      morph_seconds: 0,
      name: "cue_seq",
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toMatch(/1 warning\(s\)/);
  });

  it("passes the script to executePythonScript with captureStdout=true", async () => {
    const exec = okReport();
    await createCueSequencerImpl(fakeCtx(exec), {
      target: "/project1/viz",
      steps: [{ cue: "a", bars: 4 }],
      loop: true,
      quantize: "bar",
      morph_seconds: 0,
      name: "cue_seq",
      parent_path: "/project1",
    });
    expect(exec.mock.calls[0]?.[1]).toBe(true);
  });
});
