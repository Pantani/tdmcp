import { describe, expect, it } from "vitest";
import { significantTerms } from "../../src/tools/layer1/intent.js";

describe("significantTerms", () => {
  it("returns meaningful words from a plain description", () => {
    expect(significantTerms("plasma tunnel")).toEqual(["plasma", "tunnel"]);
  });

  it("strips words from the GENERIC_TERMS deny-list so they do not poison tag matching", () => {
    // 'generative', 'glowing', 'abstract' are all in the deny-list.
    expect(significantTerms("glowing generative abstract plasma")).toEqual(["plasma"]);
  });

  it("drops tokens that are 3 characters or shorter (too short to be discriminating)", () => {
    // All of these tokens are ≤ 3 chars; the filter is length > 3.
    expect(significantTerms("the a to go an at")).toEqual([]);
  });

  it("lowercases and splits on any non-alphanumeric boundary", () => {
    // Commas, exclamation marks, and hyphens are all split points.
    expect(significantTerms("Noise, Blur! Plasma-Tunnel")).toEqual([
      "noise",
      "blur",
      "plasma",
      "tunnel",
    ]);
  });

  it("preserves digit-containing tokens that are long enough", () => {
    // 'noise1' and 'blur2' have 6 and 5 chars, neither is in the deny-list.
    expect(significantTerms("noise1 blur2")).toEqual(["noise1", "blur2"]);
  });
});
