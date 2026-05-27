import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearEmbedCache,
  cosineSimilarity,
  embedTextsCached,
} from "../../src/knowledge/embeddings.js";

describe("cosineSimilarity", () => {
  it("is 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 6);
  });

  it("is 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });

  it("is invariant to scale", () => {
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 6);
  });

  it("ranks a closer vector higher", () => {
    const q = [1, 1, 0];
    const near = cosineSimilarity(q, [1, 0.9, 0.1]);
    const far = cosineSimilarity(q, [0, 0, 1]);
    expect(near).toBeGreaterThan(far);
  });

  it("returns 0 for a degenerate (zero) vector", () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
  });
});

const config = { llmBaseUrl: "http://localhost:1234/v1", llmModel: "test-model" };

/** Fake `/embeddings` endpoint that records the input batch of each call. */
function makeFetchMock() {
  const batches: string[][] = [];
  const fn = vi.fn(async (_url: string, init: { body: string }) => {
    const { input } = JSON.parse(init.body) as { input: string[] };
    batches.push(input);
    return {
      ok: true,
      json: async () => ({
        data: input.map((t) => ({ embedding: [t.length, t.charCodeAt(0) || 0] })),
      }),
    };
  });
  return { fn, batches };
}

describe("embedTextsCached", () => {
  beforeEach(() => clearEmbedCache());
  afterEach(() => vi.unstubAllGlobals());

  it("only sends cache misses to the endpoint on repeat calls", async () => {
    const { fn, batches } = makeFetchMock();
    vi.stubGlobal("fetch", fn);

    const first = await embedTextsCached(["q1", "opA", "opB"], config);
    expect(first).toHaveLength(3);
    expect(batches[0]).toEqual(["q1", "opA", "opB"]); // cold cache → all embedded

    const second = await embedTextsCached(["q2", "opA", "opB"], config);
    expect(second).toHaveLength(3);
    expect(batches[1]).toEqual(["q2"]); // opA/opB served from cache; only the new query is sent
    // Cached candidate vectors come back in the original input order.
    expect(second[1]).toEqual(first[1]);
    expect(second[2]).toEqual(first[2]);
  });

  it("re-embeds after clearEmbedCache", async () => {
    const { fn, batches } = makeFetchMock();
    vi.stubGlobal("fetch", fn);
    await embedTextsCached(["opA"], config);
    clearEmbedCache();
    await embedTextsCached(["opA"], config);
    expect(batches).toEqual([["opA"], ["opA"]]);
  });

  it("keys by model, so a model switch is a miss", async () => {
    const { fn, batches } = makeFetchMock();
    vi.stubGlobal("fetch", fn);
    await embedTextsCached(["opA"], config);
    await embedTextsCached(["opA"], { ...config, llmModel: "other-model" });
    expect(batches).toEqual([["opA"], ["opA"]]);
  });

  it("does not cache on failure (retries on the next call)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500 })),
    );
    await expect(embedTextsCached(["opA"], config)).rejects.toThrow();

    const { fn } = makeFetchMock();
    vi.stubGlobal("fetch", fn);
    const ok = await embedTextsCached(["opA"], config);
    expect(ok).toHaveLength(1);
    expect(fn).toHaveBeenCalledTimes(1); // endpoint was hit → the failure was not cached
  });
});
