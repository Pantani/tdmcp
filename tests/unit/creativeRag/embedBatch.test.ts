import { describe, expect, it, vi } from "vitest";
import { chunk, embedInBatches } from "../../../src/creativeRag/embedBatch.js";

describe("chunk", () => {
  it("splits exactly and preserves order", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("returns a single chunk for size 0 or negative", () => {
    expect(chunk([1, 2, 3], 0)).toEqual([[1, 2, 3]]);
    expect(chunk([1, 2, 3], -4)).toEqual([[1, 2, 3]]);
  });

  it("returns a single chunk for NaN or fractional size (never drops items)", () => {
    expect(chunk([1, 2, 3], Number.NaN)).toEqual([[1, 2, 3]]);
    expect(chunk([1, 2, 3], 1.5)).toEqual([[1, 2, 3]]);
  });

  it("returns [] for an empty input", () => {
    expect(chunk([], 2)).toEqual([]);
    expect(chunk([], 0)).toEqual([]);
  });
});

describe("embedInBatches", () => {
  it("chunks inputs, calls embedOne per chunk, concatenates in input order", async () => {
    const calls: string[][] = [];
    const embedOne = vi.fn(async (part: string[]) => {
      calls.push(part);
      return part.map((s) => [s.charCodeAt(0)]);
    });

    const out = await embedInBatches(["a", "b", "c", "d", "e"], 2, embedOne);

    expect(embedOne).toHaveBeenCalledTimes(3);
    expect(calls).toEqual([["a", "b"], ["c", "d"], ["e"]]);
    expect(out).toEqual([[97], [98], [99], [100], [101]]);
  });

  it("propagates an error from a chunk with wrong cardinality", async () => {
    const embedOne = vi.fn(async (part: string[]) => {
      if (part.includes("c")) {
        throw new Error("vector count mismatch");
      }
      return part.map(() => [0]);
    });

    const err = await embedInBatches(["a", "b", "c", "d", "e"], 2, embedOne).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("vector count mismatch");
  });

  it("returns [] for empty input with zero embedOne calls", async () => {
    const embedOne = vi.fn(async (part: string[]) => part.map(() => [0]));

    const out = await embedInBatches([], 2, embedOne);

    expect(out).toEqual([]);
    expect(embedOne).not.toHaveBeenCalled();
  });
});
