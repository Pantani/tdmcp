import { describe, expect, it, vi } from "vitest";
import {
  buildPaletteScript,
  computePaletteSwatches,
  createPaletteImpl,
  createPaletteSchema,
  hsvToRgb,
} from "../../src/tools/layer2/createPalette.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

interface Payload {
  mode: string;
  parent: string;
  name: string;
  count: number;
  source: string | null;
  expose_controls: boolean;
  rule: string;
  rules: string[];
  base_hue: number;
  saturation: number;
  value: number;
  swatches: Array<{ r: number; g: number; b: number }>;
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

/** A canned happy-path report for a 3-swatch palette. */
function okExec() {
  return vi.fn(async () => ({
    stdout: JSON.stringify({
      ramp: "/project1/palette",
      swatch_chop: "/project1/palette_swatches",
      key_dat: "/project1/palette_keys",
      swatches: [
        { r: 1, g: 0, b: 0 },
        { r: 0, g: 1, b: 0 },
        { r: 0, g: 0, b: 1 },
      ],
      channels: ["swatch0r", "swatch0g", "swatch0b", "swatch1r", "swatch1g", "swatch1b"],
      controls: ["Basehue", "Saturation", "Value", "Rule", "Count"],
      sampled: false,
      warnings: [],
      errors: [],
    }),
  }));
}

const ROUND = (s: { r: number; g: number; b: number }) => ({
  r: +s.r.toFixed(6),
  g: +s.g.toFixed(6),
  b: +s.b.toFixed(6),
});

describe("hsvToRgb", () => {
  it("maps the primary hues to pure RGB at full saturation/value", () => {
    expect(hsvToRgb(0, 1, 1)).toEqual({ r: 1, g: 0, b: 0 });
    expect(ROUND(hsvToRgb(1 / 3, 1, 1))).toEqual({ r: 0, g: 1, b: 0 });
    expect(ROUND(hsvToRgb(2 / 3, 1, 1))).toEqual({ r: 0, g: 0, b: 1 });
  });

  it("collapses to grey when saturation is 0 and wraps hues past 1", () => {
    expect(hsvToRgb(0.42, 0, 0.5)).toEqual({ r: 0.5, g: 0.5, b: 0.5 });
    // hue 1.0 wraps to 0.0 → red
    expect(hsvToRgb(1, 1, 1)).toEqual({ r: 1, g: 0, b: 0 });
  });
});

describe("computePaletteSwatches (pure harmony maths)", () => {
  it("triad from base hue 0.0 yields hues 0.0 / 0.333 / 0.666 (red, green, blue)", () => {
    const out = computePaletteSwatches({
      rule: "triad",
      base_hue: 0,
      saturation: 1,
      value: 1,
      count: 3,
    }).map(ROUND);
    expect(out).toEqual([
      { r: 1, g: 0, b: 0 },
      { r: 0, g: 1, b: 0 },
      { r: 0, g: 0, b: 1 },
    ]);
  });

  it("complementary from base hue 0.0 yields the base + its opposite (red, cyan)", () => {
    const out = computePaletteSwatches({
      rule: "complementary",
      base_hue: 0,
      saturation: 1,
      value: 1,
      count: 2,
    }).map(ROUND);
    expect(out).toEqual([
      { r: 1, g: 0, b: 0 },
      { r: 0, g: 1, b: 1 },
    ]);
  });

  it("honours saturation/value (the tool defaults desaturate the triad)", () => {
    const out = computePaletteSwatches({
      rule: "triad",
      base_hue: 0,
      saturation: 0.7,
      value: 0.9,
      count: 3,
    }).map(ROUND);
    expect(out[0]).toEqual({ r: 0.9, g: 0.27, b: 0.27 });
  });

  it("monochrome holds one hue and sweeps value dark→bright", () => {
    const out = computePaletteSwatches({
      rule: "monochrome",
      base_hue: 0.5,
      saturation: 1,
      value: 1,
      count: 3,
    });
    // All cyan-family (g === b, r the smallest), brightening across the set.
    expect(out).toHaveLength(3);
    for (const c of out) expect(c.g).toBeCloseTo(c.b, 6);
    const [first, , last] = out;
    expect(last?.g ?? 0).toBeGreaterThan(first?.g ?? 0);
  });

  it("produces exactly `count` swatches even when it exceeds the rule's anchors", () => {
    const out = computePaletteSwatches({
      rule: "tetrad",
      base_hue: 0,
      saturation: 1,
      value: 1,
      count: 5,
    });
    expect(out).toHaveLength(5);
    // The 5th reuses the first anchor (base hue, red family) at a dimmer value.
    const fifth = out[4];
    expect(fifth).toBeDefined();
    expect(fifth?.r ?? 0).toBeGreaterThan(fifth?.g ?? 0);
    expect(fifth?.r ?? 1).toBeLessThan(1);
  });
});

describe("createPaletteImpl (harmony mode)", () => {
  it("computes swatches in TS and forwards them; emits the Ramp + Constant CHOP + Table DAT machinery", async () => {
    const exec = okExec();
    const args = createPaletteSchema.parse({
      mode: "harmony",
      base_hue: 0,
      rule: "triad",
      count: 3,
      saturation: 1,
      value: 1,
      parent_path: "/project1",
      name: "palette",
    });
    const result = await createPaletteImpl(fakeCtx(exec), args);

    const p = decodePayload(scriptArg(exec));
    expect(p.mode).toBe("harmony");
    expect(p.count).toBe(3);
    // The pure maths is precomputed and shipped in the payload.
    expect(p.swatches.map(ROUND)).toEqual([
      { r: 1, g: 0, b: 0 },
      { r: 0, g: 1, b: 0 },
      { r: 0, g: 0, b: 1 },
    ]);

    const script = scriptArg(exec);
    expect(script).toContain("_parent.create(rampTOP, _name)"); // gradient
    expect(script).toContain('_parent.create(constantCHOP, _name + "_swatches")'); // swatch CHOP
    expect(script).toContain('_parent.create(tableDAT, _name + "_keys")'); // ramp key colours
    expect(script).toContain('"swatch%d%s"'); // channel naming for bind_to_channel
    expect(script).toContain("appendRow"); // key-colour table rows

    // A happy report is a non-error JSON result naming the built nodes + channels.
    expect(result.isError).toBeUndefined();
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("/project1/palette");
    expect(text).toContain("/project1/palette_swatches");
  });
});

describe("createPaletteImpl (from_source mode)", () => {
  it("forwards the source path and does not require precomputed swatches", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        ramp: "/project1/palette",
        swatch_chop: "/project1/palette_swatches",
        key_dat: "/project1/palette_keys",
        swatches: [{ r: 0.2, g: 0.2, b: 0.2 }],
        channels: ["swatch0r", "swatch0g", "swatch0b"],
        controls: [],
        sampled: true,
        warnings: [],
      }),
    }));
    const args = createPaletteSchema.parse({
      mode: "from_source",
      source: "/project1/moviein1",
      count: 4,
      parent_path: "/project1",
    });
    const result = await createPaletteImpl(fakeCtx(exec), args);

    const p = decodePayload(scriptArg(exec));
    expect(p.mode).toBe("from_source");
    expect(p.source).toBe("/project1/moviein1");
    expect(p.swatches).toEqual([]); // harmony maths not run for from_source
    // The script samples the source by down-res'ing it.
    expect(scriptArg(exec)).toContain("resolutionTOP");
    expect(result.isError).toBeUndefined();
  });
});

describe("createPaletteImpl (error + schema)", () => {
  it("turns a fatal Python report into an isError result", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        swatches: [],
        channels: [],
        controls: [],
        warnings: [],
        fatal: "Parent COMP not found: /nope",
      }),
    }));
    const result = await createPaletteImpl(fakeCtx(exec), createPaletteSchema.parse({}));
    expect(result.isError).toBe(true);
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("Parent COMP not found");
  });

  it("rejects a swatch count above the Constant CHOP channel cap", () => {
    const parsed = createPaletteSchema.safeParse({ count: 14 });
    expect(parsed.success).toBe(false);
  });

  it("applies the documented defaults", () => {
    const parsed = createPaletteSchema.parse({});
    expect(parsed.mode).toBe("harmony");
    expect(parsed.rule).toBe("triad");
    expect(parsed.count).toBe(5);
    expect(parsed.base_hue).toBe(0);
    expect(parsed.saturation).toBe(0.7);
    expect(parsed.value).toBe(0.9);
    expect(parsed.name).toBe("palette");
  });
});

describe("buildPaletteScript", () => {
  it("round-trips the payload (rules list + swatches) into the embedded base64", () => {
    const payload = {
      mode: "harmony",
      parent: "/project1",
      name: "pal",
      count: 2,
      source: null,
      expose_controls: true,
      rule: "complementary",
      rules: ["complementary", "analogous", "triad", "tetrad", "monochrome"],
      base_hue: 0,
      saturation: 1,
      value: 1,
      swatches: [
        { r: 1, g: 0, b: 0 },
        { r: 0, g: 1, b: 1 },
      ],
    };
    expect(decodePayload(buildPaletteScript(payload))).toEqual(payload);
  });
});
