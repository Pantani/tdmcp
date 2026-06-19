import { describe, expect, it, vi } from "vitest";
import {
  buildFusedContextMessage,
  DEFAULT_RRF_K,
  fusedRagSearch,
  reciprocalRankFusion,
  type UnifiedRagResult,
} from "../../src/llm/crossRagFusion.js";

interface Doc {
  id: string;
  title?: string;
}

describe("reciprocalRankFusion", () => {
  it("computes exact RRF scores and a deterministic tie-break order", () => {
    const a: Doc = { id: "a" };
    const b: Doc = { id: "b" };
    const c: Doc = { id: "c" };
    const d: Doc = { id: "d" };
    const fused = reciprocalRankFusion<Doc>(
      [
        { label: "A", items: [a, b, c] },
        { label: "B", items: [b, a, d] },
      ],
      { k: 60 },
    );

    const score = (id: string) => fused.find((f) => f.id === id)?.rrfScore;
    expect(score("a")).toBeCloseTo(1 / 61 + 1 / 62, 12);
    expect(score("b")).toBeCloseTo(1 / 62 + 1 / 61, 12);
    expect(score("c")).toBeCloseTo(1 / 63, 12);
    expect(score("d")).toBeCloseTo(1 / 63, 12);
    // a,b tie on score → bestRank both 1 → id asc → a before b.
    // c,d tie on score → bestRank both 3 → id asc → c before d.
    expect(fused.map((f) => f.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("is order-independent across the input lists (stable total order)", () => {
    const a: Doc = { id: "a" };
    const b: Doc = { id: "b" };
    const c: Doc = { id: "c" };
    const d: Doc = { id: "d" };
    const forward = reciprocalRankFusion<Doc>([
      { label: "A", items: [a, b, c] },
      { label: "B", items: [b, a, d] },
    ]);
    const swapped = reciprocalRankFusion<Doc>([
      { label: "B", items: [b, a, d] },
      { label: "A", items: [a, b, c] },
    ]);
    expect(forward.map((f) => f.id)).toEqual(swapped.map((f) => f.id));
  });

  it("defaults k to DEFAULT_RRF_K when options are omitted", () => {
    const fused = reciprocalRankFusion<Doc>([{ label: "only", items: [{ id: "x" }] }]);
    expect(fused[0]?.rrfScore).toBeCloseTo(1 / (DEFAULT_RRF_K + 1), 12);
  });

  it("preserves order for a single list (no-op passthrough property)", () => {
    const fused = reciprocalRankFusion<Doc>([
      { label: "only", items: [{ id: "x" }, { id: "y" }, { id: "z" }] },
    ]);
    expect(fused.map((f) => f.id)).toEqual(["x", "y", "z"]);
    expect(fused.map((f) => f.bestRank)).toEqual([1, 2, 3]);
    expect(fused.every((f) => f.sources.length === 1 && f.sources[0] === "only")).toBe(true);
  });

  it("returns [] for empty input and all-empty lists", () => {
    expect(reciprocalRankFusion<Doc>([])).toEqual([]);
    expect(
      reciprocalRankFusion<Doc>([
        { label: "A", items: [] },
        { label: "B", items: [] },
      ]),
    ).toEqual([]);
  });

  it("retains sources in input-list order and the item from the first contributing list", () => {
    const fromA: Doc = { id: "shared", title: "from-A" };
    const fromB: Doc = { id: "shared", title: "from-B" };
    const fused = reciprocalRankFusion<Doc>([
      { label: "A", items: [fromA] },
      { label: "B", items: [fromB] },
    ]);
    const shared = fused.find((f) => f.id === "shared");
    expect(shared?.sources).toEqual(["A", "B"]);
    expect(shared?.item.title).toBe("from-A");
  });

  it("accepts k=1 and throws RangeError for non-positive-integer k", () => {
    expect(() =>
      reciprocalRankFusion<Doc>([{ label: "A", items: [{ id: "x" }] }], { k: 1 }),
    ).not.toThrow();
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() =>
        reciprocalRankFusion<Doc>([{ label: "A", items: [{ id: "x" }] }], { k: bad }),
      ).toThrow(RangeError);
    }
  });
});

interface Hit {
  id: string;
  title: string;
  license: string;
  sourceName: string;
}

function creativeStub(hits: Hit[]) {
  return { search: vi.fn(async () => hits) } as const;
}
function projectStub(hits: Hit[]) {
  return { search: vi.fn(async () => hits) } as const;
}

const cHit = (id: string): Hit => ({
  id,
  title: `c-${id}`,
  license: "CC0",
  sourceName: "Creative",
});
const pHit = (id: string): Hit => ({ id, title: `p-${id}`, license: "MIT", sourceName: "Project" });

describe("fusedRagSearch", () => {
  it("returns undefined and runs no search when the gate is off", async () => {
    const creative = creativeStub([cHit("a")]);
    const project = projectStub([pHit("b")]);
    const out = await fusedRagSearch("q", {
      // biome-ignore lint/suspicious/noExplicitAny: minimal service stub for the test
      creative: creative as any,
      // biome-ignore lint/suspicious/noExplicitAny: minimal service stub for the test
      project: project as any,
      fusionEnabled: false,
      k: 60,
    });
    expect(out).toBeUndefined();
    expect(creative.search).not.toHaveBeenCalled();
    expect(project.search).not.toHaveBeenCalled();
  });

  it("returns undefined (passthrough) when one corpus is empty", async () => {
    const creative = creativeStub([]);
    const project = projectStub([pHit("b"), pHit("c")]);
    const out = await fusedRagSearch("q", {
      // biome-ignore lint/suspicious/noExplicitAny: minimal service stub for the test
      creative: creative as any,
      // biome-ignore lint/suspicious/noExplicitAny: minimal service stub for the test
      project: project as any,
      fusionEnabled: true,
      k: 60,
    });
    expect(out).toBeUndefined();
  });

  it("fuses both corpora into a unified, RRF-ordered list", async () => {
    const creative = creativeStub([cHit("a"), cHit("b")]);
    const project = projectStub([pHit("x"), pHit("y")]);
    const out = await fusedRagSearch("q", {
      // biome-ignore lint/suspicious/noExplicitAny: minimal service stub for the test
      creative: creative as any,
      // biome-ignore lint/suspicious/noExplicitAny: minimal service stub for the test
      project: project as any,
      fusionEnabled: true,
      k: 60,
    });
    expect(out).toBeDefined();
    const res = out as UnifiedRagResult[];
    expect(res).toHaveLength(4);
    // rank-1 of each corpus tie on score → id asc → "a" before "x".
    expect(res[0]?.id).toBe("a");
    expect(res[0]?.corpus).toBe("creative");
    expect(res[0]?.uri).toBe("tdmcp://creative/cards/a");
    const xRow = res.find((r) => r.id === "x");
    expect(xRow?.corpus).toBe("project");
    expect(xRow?.uri).toBe("tdmcp://project/cards/x");
    // descending rrfScore
    expect(res[0]?.rrfScore).toBeGreaterThanOrEqual(res[3]?.rrfScore ?? 0);
  });

  it("treats a throwing corpus as empty and warns", async () => {
    const creative = {
      search: vi.fn(async () => {
        throw new Error("boom");
      }),
    };
    const project = projectStub([pHit("x"), pHit("y")]);
    const warn = vi.fn();
    const out = await fusedRagSearch("q", {
      // biome-ignore lint/suspicious/noExplicitAny: minimal service stub for the test
      creative: creative as any,
      // biome-ignore lint/suspicious/noExplicitAny: minimal service stub for the test
      project: project as any,
      fusionEnabled: true,
      k: 60,
      logger: { warn },
    });
    expect(out).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe("buildFusedContextMessage", () => {
  it("returns undefined for an empty list", () => {
    expect(buildFusedContextMessage([])).toBeUndefined();
  });

  it("renders a role:user rag-cards block with corpus + uri per line", () => {
    const msg = buildFusedContextMessage([
      {
        id: "a",
        corpus: "creative",
        title: "Title A",
        license: "CC0",
        sourceName: "Src",
        uri: "tdmcp://creative/cards/a",
        rrfScore: 0.5,
        sources: ["creative"],
      },
    ]);
    expect(msg?.role).toBe("user");
    expect(msg?.content).toContain("```rag-cards");
    expect(msg?.content).toContain("(creative · Src, CC0)");
    expect(msg?.content).toContain("uri: tdmcp://creative/cards/a");
  });
});
