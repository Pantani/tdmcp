import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import {
  bjorklundPattern,
  buildEuclideanSequencerScript,
  createEuclideanSequencerImpl,
  createEuclideanSequencerSchema,
  rotatePattern,
} from "../../src/tools/layer2/createEuclideanSequencer.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

interface Payload {
  name: string;
  parent: string;
  target: string;
  steps: number;
  pulses: number;
  rotation: number;
  action: string;
  param: string;
  on_value: number;
  off_value: number;
  pattern: number[];
  bpm_source: string | null;
  dispatch_text: string;
  controls_exec_text: string;
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
      comp: "/project1/euclidean",
      beat: "/project1/euclidean/beat",
      table: "/project1/euclidean/step_table",
      dispatch: "/project1/euclidean/dispatch",
      controls_exec: "/project1/euclidean/controls_exec",
      controls: ["Active", "Steps", "Pulses", "Rotation"],
      steps: 16,
      pulses: 4,
      rotation: 0,
      action: "param",
      warnings: [],
      ...over,
    }),
  }));

function run(args: Parameters<typeof createEuclideanSequencerSchema.parse>[0]) {
  const exec = okReport();
  return {
    exec,
    promise: createEuclideanSequencerImpl(
      fakeCtx(exec),
      createEuclideanSequencerSchema.parse(args),
    ),
  };
}

// ── Bjorklund helper ──────────────────────────────────────────────────────────

describe("bjorklundPattern", () => {
  it("E(4,16) → four-on-the-floor", () => {
    expect(bjorklundPattern(4, 16)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
  });

  it("E(3,8) → tresillo", () => {
    expect(bjorklundPattern(3, 8)).toEqual([1, 0, 0, 1, 0, 0, 1, 0]);
  });

  it("E(5,8) → Cuban cinquillo", () => {
    expect(bjorklundPattern(5, 8)).toEqual([1, 0, 1, 1, 0, 1, 1, 0]);
  });

  it("E(0,8) → all zeros", () => {
    expect(bjorklundPattern(0, 8)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("E(8,8) → all ones", () => {
    expect(bjorklundPattern(8, 8)).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
  });

  it("E(9,8) clamps to E(8,8)", () => {
    expect(bjorklundPattern(9, 8)).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
  });
});

describe("rotatePattern", () => {
  it("rotates by 1: [1,0,0,0] → [0,1,0,0]", () => {
    expect(rotatePattern([1, 0, 0, 0], 1)).toEqual([0, 1, 0, 0]);
  });

  it("rotation 0 is identity", () => {
    expect(rotatePattern([1, 0, 1, 0], 0)).toEqual([1, 0, 1, 0]);
  });
});

// ── Schema ────────────────────────────────────────────────────────────────────

describe("createEuclideanSequencer schema", () => {
  it("applies defaults (name 'euclidean', steps 16, pulses 4, rotation 0)", () => {
    const args = createEuclideanSequencerSchema.parse({ target: "/project1/viz" });
    expect(args.name).toBe("euclidean");
    expect(args.parent_path).toBe("/project1");
    expect(args.steps).toBe(16);
    expect(args.pulses).toBe(4);
    expect(args.rotation).toBe(0);
    expect(args.action).toBe("param");
    expect(args.on_value).toBe(1.0);
    expect(args.off_value).toBe(0.0);
  });

  it("requires target", () => {
    expect(() => createEuclideanSequencerSchema.parse({})).toThrow();
  });

  it("rejects steps < 1 / > 64", () => {
    expect(() =>
      createEuclideanSequencerSchema.parse({ target: "/project1/viz", steps: 0 }),
    ).toThrow();
    expect(() =>
      createEuclideanSequencerSchema.parse({ target: "/project1/viz", steps: 65 }),
    ).toThrow();
  });

  it("rejects an unknown action value", () => {
    expect(() =>
      createEuclideanSequencerSchema.parse({ target: "/project1/viz", action: "trigger" }),
    ).toThrow();
  });
});

// ── buildEuclideanSequencerScript ─────────────────────────────────────────────

describe("buildEuclideanSequencerScript", () => {
  const script = buildEuclideanSequencerScript({
    name: "euclidean",
    parent: "/project1",
    target: "/project1/viz",
    steps: 16,
    pulses: 4,
    rotation: 0,
    action: "param",
    param: "Brightness",
    on_value: 1.0,
    off_value: 0.0,
    pattern: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
    bpm_source: null,
    dispatch_text: "DISPATCH",
    controls_exec_text: "CONTROLS_EXEC mentions Pulses and Rotation",
  });

  it("embeds pulses, rotation, dispatch_text and controls_exec_text in the payload", () => {
    const payload = decodePayload(script);
    expect(payload.pulses).toBe(4);
    expect(payload.rotation).toBe(0);
    expect(payload.dispatch_text).toBe("DISPATCH");
    expect(payload.controls_exec_text).toContain("Pulses");
    expect(payload.controls_exec_text).toContain("Rotation");
  });

  it("creates Beat CHOP + Table DAT + CHOP Execute DAT + Parameter Execute DAT", () => {
    expect(script).toContain("td.beatCHOP");
    expect(script).toContain("td.tableDAT");
    expect(script).toContain("td.chopexecuteDAT");
    expect(script).toContain("td.parameterexecuteDAT");
  });

  it("exposes Active, Steps, Pulses, Rotation controls on a custom page", () => {
    expect(script).toContain('appendToggle("Active")');
    expect(script).toContain('appendInt("Steps")');
    expect(script).toContain('appendInt("Pulses")');
    expect(script).toContain('appendInt("Rotation")');
    expect(script).toContain('appendCustomPage("Euclidean")');
  });
});

// ── Dispatch + controls-exec substitution ─────────────────────────────────────

describe("createEuclideanSequencerImpl — substitution + payload", () => {
  it("bakes target, action, and param into the dispatch callback with no placeholders", async () => {
    const { exec, promise } = run({
      target: "/project1/viz",
      action: "param",
      param: "Brightness",
    });
    await promise;
    const payload = decodePayload(scriptArg(exec));
    expect(payload.dispatch_text).not.toContain("__TARGET__");
    expect(payload.dispatch_text).not.toContain("__ACTION__");
    expect(payload.dispatch_text).not.toContain("__PARAM__");
    expect(payload.dispatch_text).toContain("/project1/viz");
    expect(payload.dispatch_text).toContain("Brightness");
  });

  it("bakes action + on_value/off_value into controls_exec_text and mentions Pulses/Rotation", async () => {
    const { exec, promise } = run({
      target: "/project1/viz",
      action: "param",
      param: "Brightness",
      on_value: 0.75,
      off_value: 0.0,
    });
    await promise;
    const payload = decodePayload(scriptArg(exec));
    expect(payload.controls_exec_text).not.toContain("__ACTION__");
    expect(payload.controls_exec_text).not.toContain("__ON_VALUE__");
    expect(payload.controls_exec_text).not.toContain("__OFF_VALUE__");
    expect(payload.controls_exec_text).toContain("Pulses");
    expect(payload.controls_exec_text).toContain("Rotation");
    expect(payload.controls_exec_text).toContain("0.75");
  });

  it("embeds the Bjorklund-computed (rotated) pattern in the payload for action=param", async () => {
    const { exec, promise } = run({
      target: "/project1/viz",
      action: "param",
      param: "Hue",
      steps: 8,
      pulses: 3,
      rotation: 0,
      on_value: 1.0,
      off_value: 0.0,
    });
    await promise;
    const payload = decodePayload(scriptArg(exec));
    // tresillo with on=1, off=0
    expect(payload.pattern).toEqual([1, 0, 0, 1, 0, 0, 1, 0]);
  });

  it("rotates the pattern by `rotation` steps", async () => {
    const { exec, promise } = run({
      target: "/project1/viz",
      action: "param",
      param: "Hue",
      steps: 8,
      pulses: 3,
      rotation: 1,
    });
    await promise;
    const payload = decodePayload(scriptArg(exec));
    expect(payload.pattern).toEqual([0, 1, 0, 0, 1, 0, 0, 1]);
  });
});

// ── Result shape ──────────────────────────────────────────────────────────────

describe("createEuclideanSequencerImpl — result shape", () => {
  it("summarises comp path + E(p,s) + rotation on success", async () => {
    const exec = okReport();
    const result = await createEuclideanSequencerImpl(
      fakeCtx(exec),
      createEuclideanSequencerSchema.parse({
        target: "/project1/viz",
        param: "Brightness",
      }),
    );
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("/project1/euclidean");
    expect(text).toContain("E(4,16)");
    expect(text).toContain("UNVERIFIED");
  });

  it("notes warning count when present (clamp pulses>steps)", async () => {
    const exec = okReport({
      pulses: 8,
      steps: 8,
      warnings: ["pulses (9) clamped to steps (8)."],
    });
    const result = await createEuclideanSequencerImpl(
      fakeCtx(exec),
      createEuclideanSequencerSchema.parse({
        target: "/project1/viz",
        param: "Brightness",
        steps: 8,
        pulses: 9,
      }),
    );
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toMatch(/1 warning\(s\)/);
  });

  it("returns isError (no throw) when action=param but param is missing", async () => {
    const exec = okReport();
    const result = await createEuclideanSequencerImpl(fakeCtx(exec), {
      name: "euclidean",
      parent_path: "/project1",
      target: "/project1/viz",
      steps: 16,
      pulses: 4,
      rotation: 0,
      action: "param",
      param: undefined,
      on_value: 1.0,
      off_value: 0.0,
      bpm_source: undefined,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("param");
    expect(exec).not.toHaveBeenCalled();
  });

  it("returns isError when report.fatal is set", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        comp: "/project1",
        beat: "",
        table: "",
        dispatch: "",
        controls_exec: "",
        controls: [],
        steps: 16,
        pulses: 4,
        rotation: 0,
        action: "param",
        warnings: [],
        fatal: "COMP not found: /project1/missing",
      }),
    }));
    const result = await createEuclideanSequencerImpl(fakeCtx(exec), {
      name: "euclidean",
      parent_path: "/project1",
      target: "/project1/missing",
      steps: 16,
      pulses: 4,
      rotation: 0,
      action: "param",
      param: "Brightness",
      on_value: 1.0,
      off_value: 0.0,
      bpm_source: undefined,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("COMP not found");
  });

  it("cue action succeeds without a param field, and embeds 0/1 cells", async () => {
    const exec = okReport({ action: "cue" });
    const result = await createEuclideanSequencerImpl(
      fakeCtx(exec),
      createEuclideanSequencerSchema.parse({
        target: "/project1/viz",
        action: "cue",
        steps: 8,
        pulses: 3,
      }),
    );
    expect(result.isError).toBeFalsy();
    const payload = decodePayload(scriptArg(exec));
    // pattern cells for cue action are raw bits (0/1), not on_value/off_value
    expect(payload.pattern).toEqual([1, 0, 0, 1, 0, 0, 1, 0]);
  });

  it("passes captureStdout=true to executePythonScript", async () => {
    const { exec, promise } = run({ target: "/project1/viz", param: "Brightness" });
    await promise;
    expect(exec.mock.calls[0]?.[1]).toBe(true);
  });
});
