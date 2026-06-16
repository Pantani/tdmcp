import { describe, expect, it } from "vitest";
import { cosineSimilarity, norm, normalize } from "../../../src/creativeRag/cosine.js";

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
  });

  it("returns 1 for parallel vectors of different magnitude", () => {
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 10);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
  });

  it("returns -1 for opposite vectors", () => {
    expect(cosineSimilarity([1, 2], [-1, -2])).toBeCloseTo(-1, 10);
  });

  it("returns 0 when the first vector is zero", () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
  });

  it("returns 0 when the second vector is zero", () => {
    expect(cosineSimilarity([1, 2, 3], [0, 0, 0])).toBe(0);
  });

  it("returns 0 when lengths differ", () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });

  it("returns 0 for empty vectors", () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });
});

describe("norm / normalize", () => {
  it("computes the L2 norm", () => {
    expect(norm([3, 4])).toBeCloseTo(5, 10);
  });

  it("normalizes to unit length", () => {
    const unit = normalize([3, 4]);
    expect(norm(unit)).toBeCloseTo(1, 10);
  });

  it("returns a zero vector unchanged", () => {
    expect(normalize([0, 0])).toEqual([0, 0]);
  });
});
