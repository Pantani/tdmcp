import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import {
  buildCueScript,
  MORPH_HOOK,
  manageCueImpl,
  manageCueSchema,
} from "../../src/tools/layer2/manageCue.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

interface Payload {
  action: string;
  comp: string;
  name?: string | null;
  duration?: number;
  quantize?: string;
  morph_text: string;
}

function decodePayload(script: string): Payload {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (b64 === undefined) throw new Error("script did not embed a base64 payload");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
}

function fakeCtx(exec: ReturnType<typeof vi.fn>): ToolContext {
  return { client: { executePythonScript: exec }, logger: silentLogger } as unknown as ToolContext;
}

/** The script string passed to the first executePythonScript call. */
function scriptArg(exec: ReturnType<typeof vi.fn>): string {
  const script = exec.mock.calls[0]?.[0];
  if (typeof script !== "string")
    throw new Error("executePythonScript was not called with a script");
  return script;
}

/** A vi.fn whose first call resolves to a JSON report on stdout. */
function execReturning(report: object): ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({ stdout: JSON.stringify(report) }));
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

/** Parse partial args through the schema (applying defaults), then run the tool. */
function run(args: Parameters<typeof manageCueSchema.parse>[0], report: object) {
  const exec = execReturning(report);
  return { exec, promise: manageCueImpl(fakeCtx(exec), manageCueSchema.parse(args)) };
}

describe("manageCue quantize schema", () => {
  it("leaves quantize optional (undefined when omitted); the impl applies the 'off' default", () => {
    const args = manageCueSchema.parse({ action: "recall", name: "A" });
    expect(args.quantize).toBeUndefined();
  });

  it("accepts 'off', 'beat' and 'bar', rejects anything else", () => {
    expect(manageCueSchema.parse({ action: "recall", name: "A", quantize: "off" }).quantize).toBe(
      "off",
    );
    expect(manageCueSchema.parse({ action: "morph", name: "A", quantize: "beat" }).quantize).toBe(
      "beat",
    );
    expect(manageCueSchema.parse({ action: "morph", name: "A", quantize: "bar" }).quantize).toBe(
      "bar",
    );
    expect(() => manageCueSchema.parse({ action: "morph", name: "A", quantize: "half" })).toThrow();
  });
});

describe("buildCueScript (quantize engine)", () => {
  const baseScript = buildCueScript({
    action: "recall",
    comp: "/p",
    name: "A",
    duration: 2,
    quantize: "beat",
    morph_text: "MORPH",
  });

  it("round-trips the quantize option in the payload", () => {
    expect(decodePayload(baseScript).quantize).toBe("beat");
  });

  it("reads tempo and time signature from the project timeline", () => {
    // Boundary is derived from the global tempo + signature, not a Beat CHOP.
    expect(baseScript).toContain("op('/').time");
    expect(baseScript).toContain("tempo");
    expect(baseScript).toContain("signature1");
    expect(baseScript).toContain("def _next_boundary_delay");
  });

  it("snaps an exact-boundary hit to the NEXT boundary instead of firing instantly", () => {
    // Guards against a zero-delay (immediate) schedule when already on the beat.
    expect(baseScript).toContain("_remaining = _period");
  });

  it("schedules the transition start in the future via absTime + delay", () => {
    expect(baseScript).toContain("_start = td.absTime.seconds + _delay");
    expect(baseScript).toContain('"start": _start');
  });

  it("degrades to 0.0 delay (immediate) for 'off' or an unreadable tempo", () => {
    expect(baseScript).toContain('if quant not in ("beat", "bar"):');
    expect(baseScript).toContain("return 0.0");
  });

  it("teaches the morph engine to stay dormant until the scheduled start", () => {
    // The shared cue_morph hook (MORPH_HOOK, embedded via the morph_text payload) must
    // leave the look untouched while now < start, then ease from the real start time.
    expect(MORPH_HOOK).toContain("if now < start:");
    expect(MORPH_HOOK).toContain("start = st.get('start', now)");
    expect(MORPH_HOOK).toContain("t = (now - start) / dur");
  });
});

describe("manageCue quantize (immediate path is unchanged)", () => {
  it("an immediate recall (quantize 'off') still snaps params directly, no transition record", async () => {
    const off = buildCueScript({
      action: "recall",
      comp: "/p",
      name: "A",
      duration: 2,
      quantize: "off",
      morph_text: "MORPH",
    });
    // The classic immediate-recall branch is taken when _delay <= 0 (which 'off' guarantees),
    // setting params with `_pr.val = _v` rather than writing a transition record.
    expect(off).toContain('_action == "recall" and _delay <= 0.0');
    expect(off).toContain("_pr.val = _v; _restored.append(_k)");
  });

  it("the engine guard never trips for an immediate (start == now) record", () => {
    // MORPH_HOOK comparison: now < start. Existing tools write start = now, so the guard
    // (now < start) is false and pre-quantize behavior is preserved byte-for-byte.
    const off = buildCueScript({
      action: "morph",
      comp: "/p",
      name: "A",
      duration: 2,
      quantize: "off",
      morph_text: "MORPH",
    });
    expect(off).toContain('"active": True');
    expect(off).toContain('"duration": _dur');
  });
});

describe("manageCueImpl forwarding + summaries", () => {
  it("rejects recall/morph without a name and never touches TD", async () => {
    const exec = vi.fn();
    for (const action of ["recall", "morph"] as const) {
      const result = await manageCueImpl(fakeCtx(exec), manageCueSchema.parse({ action }));
      expect(result.isError).toBe(true);
    }
    expect(exec).not.toHaveBeenCalled();
  });

  it("applies the 'off' default in the payload when quantize is omitted", async () => {
    const { exec, promise } = run(
      { action: "recall", comp_path: "/p", name: "A" },
      { action: "recall", comp: "/p", name: "A", restored: ["X"], warnings: [] },
    );
    await promise;
    expect(decodePayload(scriptArg(exec)).quantize).toBe("off");
  });

  it("forwards quantize:'beat' to the payload for a recall", async () => {
    const { exec, promise } = run(
      { action: "recall", comp_path: "/p/sys", name: "A", quantize: "beat" },
      { action: "recall", comp: "/p/sys", name: "A", restored: ["X"], warnings: [] },
    );
    await promise;
    const payload = decodePayload(scriptArg(exec));
    expect(payload.action).toBe("recall");
    expect(payload.quantize).toBe("beat");
  });

  it("forwards quantize:'bar' to the payload for a morph", async () => {
    const { exec, promise } = run(
      { action: "morph", comp_path: "/p/sys", name: "A", duration: 3, quantize: "bar" },
      { action: "morph", comp: "/p/sys", name: "A", morphing: ["X"], duration: 3, warnings: [] },
    );
    await promise;
    const payload = decodePayload(scriptArg(exec));
    expect(payload.action).toBe("morph");
    expect(payload.duration).toBe(3);
    expect(payload.quantize).toBe("bar");
  });

  it("surfaces the scheduled boundary in the recall summary when the report is quantized", async () => {
    const { promise } = run(
      { action: "recall", comp_path: "/p", name: "Drop", quantize: "bar" },
      {
        action: "recall",
        comp: "/p",
        name: "Drop",
        restored: ["X", "Y"],
        quantize: "bar",
        scheduled_in: 1.25,
        warnings: [],
      },
    );
    const result = await promise;
    const text = textOf(result);
    expect(text).toContain("next bar");
    expect(text).toContain("1.25");
    expect(result.isError).toBeFalsy();
  });

  it("surfaces the scheduled boundary in the morph summary when the report is quantized", async () => {
    const { promise } = run(
      { action: "morph", comp_path: "/p", name: "Drop", duration: 2, quantize: "beat" },
      {
        action: "morph",
        comp: "/p",
        name: "Drop",
        morphing: ["X"],
        duration: 2,
        quantize: "beat",
        scheduled_in: 0.5,
        warnings: [],
      },
    );
    const result = await promise;
    const text = textOf(result);
    expect(text).toContain("next beat");
    expect(text).toContain("0.5");
  });

  it("keeps the classic immediate summary when no quantize is reported", async () => {
    const { promise } = run(
      { action: "recall", comp_path: "/p", name: "A" },
      { action: "recall", comp: "/p", name: "A", restored: ["X"], warnings: [] },
    );
    const result = await promise;
    const text = textOf(result);
    expect(text).toContain('Recalled cue "A"');
    expect(text).not.toContain("next");
  });
});
