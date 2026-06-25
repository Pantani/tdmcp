import { describe, expect, it } from "vitest";
import { hexToRgb, hexToRgbTuple, parseHexColor, rgbToHex } from "../../src/tools/util/color.js";

describe("parseHexColor", () => {
  it("parses 6-digit hex with and without the leading #", () => {
    expect(parseHexColor("#ff0000")).toEqual([1, 0, 0]);
    expect(parseHexColor("00ff00")).toEqual([0, 1, 0]);
  });

  it("is case-insensitive and trims surrounding whitespace", () => {
    expect(parseHexColor("  #00FF80  ")).toEqual([0, 1, 128 / 255]);
  });

  it("returns undefined for malformed input", () => {
    expect(parseHexColor("not-a-color")).toBeUndefined();
    expect(parseHexColor("#12")).toBeUndefined();
    expect(parseHexColor("")).toBeUndefined();
  });

  it("tolerates missing input (undefined/null) instead of throwing", () => {
    // The helper is shared and some call sites pass schema args directly; a
    // missing value must degrade to undefined, not crash on `.trim()`.
    expect(parseHexColor(undefined as unknown as string)).toBeUndefined();
    expect(parseHexColor(null as unknown as string)).toBeUndefined();
  });

  it("rejects 3-digit shorthand by default (6-digit only)", () => {
    expect(parseHexColor("#abc")).toBeUndefined();
  });

  it("accepts and expands 3-digit shorthand when enabled", () => {
    // #abc → #aabbcc
    expect(parseHexColor("#abc", { shorthand: true })).toEqual([
      0xaa / 255,
      0xbb / 255,
      0xcc / 255,
    ]);
    // 6-digit still works with shorthand enabled
    expect(parseHexColor("ffffff", { shorthand: true })).toEqual([1, 1, 1]);
  });
});

describe("hexToRgbTuple", () => {
  it("returns the parsed tuple on valid input", () => {
    expect(hexToRgbTuple("#ff0000", [1, 1, 1])).toEqual([1, 0, 0]);
  });

  it("returns the fallback tuple on malformed input", () => {
    expect(hexToRgbTuple("nope", [0.2, 0.9, 1])).toEqual([0.2, 0.9, 1]);
  });

  it("honors the shorthand option for the fallback decision", () => {
    expect(hexToRgbTuple("#abc", [1, 1, 1])).toEqual([1, 1, 1]); // shorthand off → fallback
    expect(hexToRgbTuple("#abc", [1, 1, 1], { shorthand: true })).toEqual([
      0xaa / 255,
      0xbb / 255,
      0xcc / 255,
    ]);
  });
});

describe("hexToRgb (object shape)", () => {
  it("returns an { r, g, b } object on valid input", () => {
    expect(hexToRgb("#0000ff", { r: 1, g: 1, b: 1 })).toEqual({ r: 0, g: 0, b: 1 });
  });

  it("returns the fallback object on malformed input", () => {
    expect(hexToRgb("xyz", { r: 0, g: 1, b: 0.53 })).toEqual({ r: 0, g: 1, b: 0.53 });
  });

  it("supports shorthand when requested", () => {
    expect(hexToRgb("#f00", { r: 1, g: 1, b: 1 }, { shorthand: true })).toEqual({
      r: 1,
      g: 0,
      b: 0,
    });
  });
});

describe("rgbToHex", () => {
  it("formats a 0..1 tuple back to #rrggbb", () => {
    expect(rgbToHex([1, 0, 0])).toBe("#ff0000");
    expect(rgbToHex([0, 1, 0])).toBe("#00ff00");
  });

  it("round-trips with parseHexColor", () => {
    const hex = "#33ccff";
    const rgb = parseHexColor(hex);
    expect(rgb).toBeDefined();
    expect(rgbToHex(rgb as [number, number, number])).toBe(hex);
  });
});
