import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import {
  buildModulatorsScript,
  createModulatorsImpl,
  createModulatorsSchema,
} from "../../src/tools/layer2/createModulators.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ModSpec {
  channel: string;
  shape: string;
  kind: "lfo" | "noise";
  wavetype?: string;
  amp: number;
  offset: number;
  phase: number;
  cpb: number;
  beats_per_cycle: number;
  rate_beats: number;
  freq_expr?: string;
  period_expr?: string;
}

interface Payload {
  name: string;
  parent_path: string;
  tempo_source: string | null;
  bpm_channel: string;
  expose_controls: boolean;
  modulators: ModSpec[];
}

function decodePayload(script: string): Payload {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (b64 === undefined) throw new Error("no base64 payload found in script");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as Payload;
}

/** The bridge mock: a vi.fn typed with the real executePythonScript signature so its
 *  recorded call args (script, captureStdout) are indexable under noUncheckedIndexedAccess. */
type ExecMock = ReturnType<typeof vi.fn<(script: string, captureStdout?: boolean) => unknown>>;

function fakeCtx(exec: ExecMock): ToolContext {
  return {
    client: { executePythonScript: exec },
    logger: silentLogger,
  } as unknown as ToolContext;
}

function scriptArg(exec: ExecMock): string {
  const s = exec.mock.calls[0]?.[0];
  if (typeof s !== "string") throw new Error("executePythonScript not called with a string");
  return s;
}

/** The `captureStdout` flag the impl passed on its first exec call (must be true). */
function captureStdoutArg(exec: ExecMock): boolean | undefined {
  return exec.mock.calls[0]?.[1];
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

/** Defaults the schema would fill in; spread over per-test modulator overrides. */
const MOD_DEFAULTS = {
  shape: "sine" as const,
  rate_beats: 4,
  depth_min: 0,
  depth_max: 1,
  phase: 0,
};

/** Per-test override: the top-level bank fields plus raw modulator inputs (the user-facing
 *  shape, not the TS-computed ModSpec). `modulators` is deliberately the input record array. */
type ArgsOverride = Partial<Omit<Payload, "modulators">> & {
  modulators: Array<Record<string, unknown>>;
};

/** Full args (all defaulted fields explicit — Impl is called directly, not via the schema). */
function args(over: ArgsOverride) {
  return {
    name: over.name ?? "modulators",
    parent_path: over.parent_path ?? "/project1",
    tempo_source: over.tempo_source ?? undefined,
    bpm_channel: over.bpm_channel ?? "bpm",
    expose_controls: over.expose_controls ?? true,
    modulators: over.modulators.map((m) => ({ ...MOD_DEFAULTS, ...m })),
  } as Parameters<typeof createModulatorsImpl>[1];
}

/** A representative success report the Python pass would emit. */
function happyReport(
  over: Partial<{
    channels: string[];
    tempo_source: string;
    beat_created: boolean;
    controls: string[];
    time_playing: boolean;
    warnings: string[];
    fatal: string;
  }> = {},
) {
  const channels = over.channels ?? ["mod1"];
  return JSON.stringify({
    comp: "/project1/modulators",
    out_chop: "/project1/modulators/mod_out",
    channels,
    tempo_source: over.tempo_source ?? "/project1/modulators/beat",
    beat_created: over.beat_created ?? true,
    modulators: channels.map((c) => ({
      op: `/project1/modulators/lfo_${c}`,
      channel: c,
      shape: "sine",
      rate_beats: 4,
    })),
    time_playing: over.time_playing ?? true,
    ...(over.controls ? { controls: over.controls } : {}),
    warnings: over.warnings ?? [],
    ...(over.fatal ? { fatal: over.fatal } : {}),
  });
}

// ---------------------------------------------------------------------------
// Schema defaults
// ---------------------------------------------------------------------------

describe("createModulatorsSchema defaults", () => {
  it("applies documented defaults and per-modulator defaults", () => {
    const parsed = createModulatorsSchema.parse({ modulators: [{}] });
    expect(parsed.name).toBe("modulators");
    expect(parsed.parent_path).toBe("/project1");
    expect(parsed.bpm_channel).toBe("bpm");
    expect(parsed.expose_controls).toBe(true);
    expect(parsed.modulators[0]).toMatchObject({
      shape: "sine",
      rate_beats: 4,
      depth_min: 0,
      depth_max: 1,
      phase: 0,
    });
  });

  it("requires at least one modulator and caps at 32", () => {
    expect(() => createModulatorsSchema.parse({ modulators: [] })).toThrow();
    expect(() =>
      createModulatorsSchema.parse({ modulators: Array.from({ length: 33 }, () => ({})) }),
    ).toThrow();
  });

  it("rejects an out-of-range phase and a non-positive rate", () => {
    expect(() => createModulatorsSchema.parse({ modulators: [{ phase: 1.5 }] })).toThrow();
    expect(() => createModulatorsSchema.parse({ modulators: [{ rate_beats: 0 }] })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 1. Payload embeds the bank
// ---------------------------------------------------------------------------

describe("buildModulatorsScript (pure payload)", () => {
  it("script imports json/base64 and prints json.dumps(report); template wires the bank ops", () => {
    const script = buildModulatorsScript({ modulators: [] });
    expect(script).toContain("import json, base64");
    expect(script).toContain("print(json.dumps(report))");
    expect(script).toContain("containerCOMP");
    expect(script).toContain("lfoCHOP");
    expect(script).toContain("noiseCHOP");
    expect(script).toContain("mergeCHOP");
    expect(script).toContain("nullCHOP");
    // The paused-timeline gotcha is surfaced from TD, not faked away.
    expect(script).toContain("op('/').time.play");
  });

  it("embeds comp name, resolved tempo op + bpm channel, and one entry per modulator", async () => {
    const exec = vi.fn(async () => ({ stdout: happyReport({ channels: ["breathe", "sweep"] }) }));
    await createModulatorsImpl(
      fakeCtx(exec),
      args({
        modulators: [
          { name: "breathe", shape: "sine" },
          { name: "sweep", shape: "saw" },
        ],
      }),
    );
    const payload = decodePayload(scriptArg(exec));
    expect(payload.name).toBe("modulators");
    expect(payload.bpm_channel).toBe("bpm");
    expect(payload.modulators).toHaveLength(2);
    expect(payload.modulators.map((m) => m.channel)).toEqual(["breathe", "sweep"]);
    // Default (no tempo_source) → expressions reference the bank's own internal Beat CHOP.
    expect(payload.modulators[0]?.freq_expr).toContain("op('/project1/modulators/beat')['bpm']");
    expect(captureStdoutArg(exec)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Bipolarity branch (the load-bearing math)
// ---------------------------------------------------------------------------

describe("bipolarity-aware amp/offset", () => {
  it("sine (bipolar) over 0–2 → amp 1, offset 1; saw (unipolar) over 0–2 → amp 2, offset 0", async () => {
    const exec = vi.fn(async () => ({ stdout: happyReport({ channels: ["a", "b"] }) }));
    await createModulatorsImpl(
      fakeCtx(exec),
      args({
        modulators: [
          { name: "a", shape: "sine", depth_min: 0, depth_max: 2 },
          { name: "b", shape: "saw", depth_min: 0, depth_max: 2 },
        ],
      }),
    );
    const mods = decodePayload(scriptArg(exec)).modulators;
    const sine = mods.find((m) => m.channel === "a");
    const saw = mods.find((m) => m.channel === "b");
    expect(sine).toMatchObject({ amp: 1, offset: 1, kind: "lfo", wavetype: "sin" });
    expect(saw).toMatchObject({ amp: 2, offset: 0, kind: "lfo", wavetype: "ramp" });
  });

  it("square (bipolar) over 0–2 → amp 1, offset 1; random (unipolar) over 0–2 → amp 2, offset 0", async () => {
    const exec = vi.fn(async () => ({ stdout: happyReport({ channels: ["sq", "rnd"] }) }));
    await createModulatorsImpl(
      fakeCtx(exec),
      args({
        modulators: [
          { name: "sq", shape: "square", depth_min: 0, depth_max: 2 },
          { name: "rnd", shape: "random", depth_min: 0, depth_max: 2 },
        ],
      }),
    );
    const mods = decodePayload(scriptArg(exec)).modulators;
    expect(mods.find((m) => m.channel === "sq")).toMatchObject({ amp: 1, offset: 1 });
    expect(mods.find((m) => m.channel === "rnd")).toMatchObject({ amp: 2, offset: 0 });
  });

  it("respects a non-zero depth_min for bipolar (1–3 sine → amp 1, offset 2)", async () => {
    const exec = vi.fn(async () => ({ stdout: happyReport({ channels: ["c"] }) }));
    await createModulatorsImpl(
      fakeCtx(exec),
      args({ modulators: [{ name: "c", shape: "sine", depth_min: 1, depth_max: 3 }] }),
    );
    expect(decodePayload(scriptArg(exec)).modulators[0]).toMatchObject({ amp: 1, offset: 2 });
  });
});

// ---------------------------------------------------------------------------
// 3. Tempo-lock expression + cycles-per-beat
// ---------------------------------------------------------------------------

describe("tempo-lock expression", () => {
  it("freq_expr divides bpm by 60 and multiplies by cpb; rate_beats=4 → cpb 0.25, 0.5 → cpb 2", async () => {
    const exec = vi.fn(async () => ({ stdout: happyReport({ channels: ["slow", "fast"] }) }));
    await createModulatorsImpl(
      fakeCtx(exec),
      args({
        // No master Rate factor so the bare tempo math is asserted cleanly.
        expose_controls: false,
        modulators: [
          { name: "slow", shape: "sine", rate_beats: 4 },
          { name: "fast", shape: "sine", rate_beats: 0.5 },
        ],
      }),
    );
    const mods = decodePayload(scriptArg(exec)).modulators;
    const slow = mods.find((m) => m.channel === "slow");
    const fast = mods.find((m) => m.channel === "fast");
    expect(slow?.cpb).toBe(0.25);
    expect(fast?.cpb).toBe(2);
    expect(slow?.freq_expr).toBe("op('/project1/modulators/beat')['bpm'] / 60.0 * 0.25");
    expect(fast?.freq_expr).toBe("op('/project1/modulators/beat')['bpm'] / 60.0 * 2");
  });
});

// ---------------------------------------------------------------------------
// 4. External tempo_source wins / internal Beat CHOP fallback
// ---------------------------------------------------------------------------

describe("tempo source resolution", () => {
  it("uses an external tempo_source in the expression and reports beat_created=false", async () => {
    const exec = vi.fn(async () => ({
      stdout: happyReport({ beat_created: false, tempo_source: "/project1/tempo_sync/tempo" }),
    }));
    const result = await createModulatorsImpl(
      fakeCtx(exec),
      args({
        tempo_source: "/project1/tempo_sync/tempo",
        expose_controls: false,
        modulators: [{ name: "mod1", shape: "sine" }],
      }),
    );
    const payload = decodePayload(scriptArg(exec));
    expect(payload.tempo_source).toBe("/project1/tempo_sync/tempo");
    expect(payload.modulators[0]?.freq_expr).toContain("op('/project1/tempo_sync/tempo')['bpm']");
    expect(textOf(result)).toContain("/project1/tempo_sync/tempo");
  });

  it("falls back to an internal Beat CHOP (no tempo_source) and reports beat_created=true", async () => {
    const exec = vi.fn(async () => ({ stdout: happyReport({ beat_created: true }) }));
    const result = await createModulatorsImpl(
      fakeCtx(exec),
      args({ expose_controls: false, modulators: [{ shape: "sine" }] }),
    );
    expect(decodePayload(scriptArg(exec)).tempo_source).toBeNull();
    expect(textOf(result)).toContain("TD global tempo");
  });
});

// ---------------------------------------------------------------------------
// 5. Random S&H routes to noise
// ---------------------------------------------------------------------------

describe("random sample-&-hold", () => {
  it("flags a random modulator as kind:noise with a period_expr and no wavetype", async () => {
    const exec = vi.fn(async () => ({ stdout: happyReport({ channels: ["rnd"] }) }));
    await createModulatorsImpl(
      fakeCtx(exec),
      args({
        expose_controls: false,
        modulators: [{ name: "rnd", shape: "random", rate_beats: 2 }],
      }),
    );
    const m = decodePayload(scriptArg(exec)).modulators[0];
    expect(m?.kind).toBe("noise");
    expect(m?.wavetype).toBeUndefined();
    expect(m?.period_expr).toBe("60.0 / op('/project1/modulators/beat')['bpm'] * 2");
    // beats_per_cycle is the reciprocal of cpb (hold = one modulator cycle).
    expect(m?.beats_per_cycle).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 6. expose_controls toggles the master page + the Rate factor
// ---------------------------------------------------------------------------

describe("expose_controls", () => {
  it("true → freq_expr carries the .par.Rate factor; report controls include Rate/Depth", async () => {
    const exec = vi.fn(async () => ({
      stdout: happyReport({ channels: ["m"], controls: ["Rate", "Depth"] }),
    }));
    const result = await createModulatorsImpl(
      fakeCtx(exec),
      args({ expose_controls: true, modulators: [{ name: "m", shape: "sine" }] }),
    );
    const payload = decodePayload(scriptArg(exec));
    expect(payload.expose_controls).toBe(true);
    expect(payload.modulators[0]?.freq_expr).toContain("op('/project1/modulators').par.Rate");
    expect(textOf(result)).toContain("Rate, Depth");
  });

  it("false → no Rate factor in the expression and the payload flag is off", async () => {
    const exec = vi.fn(async () => ({ stdout: happyReport({ channels: ["m"] }) }));
    await createModulatorsImpl(
      fakeCtx(exec),
      args({ expose_controls: false, modulators: [{ name: "m", shape: "sine" }] }),
    );
    const payload = decodePayload(scriptArg(exec));
    expect(payload.expose_controls).toBe(false);
    expect(payload.modulators[0]?.freq_expr).not.toContain(".par.Rate");
  });

  it("random S&H period folds the Rate factor in as a divisor when controls are exposed", async () => {
    const exec = vi.fn(async () => ({ stdout: happyReport({ channels: ["rnd"] }) }));
    await createModulatorsImpl(
      fakeCtx(exec),
      args({
        expose_controls: true,
        modulators: [{ name: "rnd", shape: "random", rate_beats: 2 }],
      }),
    );
    const m = decodePayload(scriptArg(exec)).modulators[0];
    expect(m?.period_expr).toBe(
      "(60.0 / op('/project1/modulators/beat')['bpm'] * 2) / op('/project1/modulators').par.Rate",
    );
  });
});

// ---------------------------------------------------------------------------
// 7. Paused-timeline edge case (the surfaced gotcha)
// ---------------------------------------------------------------------------

describe("paused-timeline surfacing", () => {
  it("time_playing:false → summary warns the bank is frozen until Play", async () => {
    const exec = vi.fn(async () => ({ stdout: happyReport({ time_playing: false }) }));
    const result = await createModulatorsImpl(
      fakeCtx(exec),
      args({ modulators: [{ shape: "sine" }] }),
    );
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("timeline is paused");
    expect(text).toContain("frozen");
  });

  it("time_playing:true → no paused warning", async () => {
    const exec = vi.fn(async () => ({ stdout: happyReport({ time_playing: true }) }));
    const result = await createModulatorsImpl(
      fakeCtx(exec),
      args({ modulators: [{ shape: "sine" }] }),
    );
    expect(textOf(result)).not.toContain("timeline is paused");
  });
});

// ---------------------------------------------------------------------------
// Duplicate channel-name de-duplication (Overlaps #4)
// ---------------------------------------------------------------------------

describe("duplicate channel names", () => {
  it("suffixes a repeated name (_2) and surfaces a warning", async () => {
    const exec = vi.fn(async () => ({ stdout: happyReport({ channels: ["sweep", "sweep_2"] }) }));
    const result = await createModulatorsImpl(
      fakeCtx(exec),
      args({
        modulators: [
          { name: "sweep", shape: "sine" },
          { name: "sweep", shape: "saw" },
        ],
      }),
    );
    const channels = decodePayload(scriptArg(exec)).modulators.map((m) => m.channel);
    expect(channels).toEqual(["sweep", "sweep_2"]);
    expect(textOf(result)).toContain("warning(s)");
    expect(textOf(result)).toMatch(/renamed to 'sweep_2'/);
  });
});

// ---------------------------------------------------------------------------
// 8. fatal → error result
// ---------------------------------------------------------------------------

describe("createModulatorsImpl — fatal & offline", () => {
  it("fatal report → isError:true with the message; does not throw", async () => {
    const exec = vi.fn(async () => ({ stdout: happyReport({ fatal: "Parent not found" }) }));
    const result = await createModulatorsImpl(
      fakeCtx(exec),
      args({ parent_path: "/missing", modulators: [{ shape: "sine" }] }),
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Parent not found");
    expect(captureStdoutArg(exec)).toBe(true);
  });

  it("TD offline (thrown error) → isError:true via guardTd, no throw out of impl", async () => {
    const exec = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const result = await createModulatorsImpl(
      fakeCtx(exec),
      args({ modulators: [{ shape: "sine" }] }),
    );
    expect(result.isError).toBe(true);
  });
});
