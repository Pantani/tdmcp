import { describe, expect, it } from "vitest";
import {
  compactKey,
  normalizeGlsl,
  normalizePatterns,
  slugify,
  toOperatorSummary,
  toPythonSummary,
  toTutorialSummary,
} from "../../src/knowledge/normalize.js";

describe("knowledge/normalize slugify + compactKey", () => {
  it("slugifies mixed punctuation and whitespace", () => {
    expect(slugify("  Noise TOP!  ")).toBe("noise_top");
    expect(slugify("Hello---World__Test")).toBe("hello_world_test");
    expect(slugify("__leading_and_trailing__")).toBe("leading_and_trailing");
  });

  it("compactKey unifies surface forms", () => {
    expect(compactKey("Noise TOP")).toBe("noisetop");
    expect(compactKey("noiseTOP")).toBe("noisetop");
    expect(compactKey("noise_top")).toBe("noisetop");
  });
});

describe("knowledge/normalize summary helpers", () => {
  it("toOperatorSummary applies defaults from doc", () => {
    const s = toOperatorSummary("noise_top", {
      name: "Noise TOP",
      summary: "noise",
    } as never);
    expect(s).toEqual({
      slug: "noise_top",
      name: "Noise TOP",
      displayName: "Noise TOP",
      category: "Unknown",
      subcategory: "",
      summary: "noise",
      keywords: [],
    });
  });

  it("toOperatorSummary prefers displayName/category/subcategory/keywords/description fallback", () => {
    const s = toOperatorSummary("noise_top", {
      name: "Noise TOP",
      displayName: "Noise",
      category: "TOP",
      subcategory: "Generator",
      description: "desc-fallback",
      keywords: ["a", "b"],
    } as never);
    expect(s.displayName).toBe("Noise");
    expect(s.category).toBe("TOP");
    expect(s.subcategory).toBe("Generator");
    expect(s.summary).toBe("desc-fallback");
    expect(s.keywords).toEqual(["a", "b"]);
  });

  it("toPythonSummary counts methods and members and defaults displayName/category", () => {
    const s = toPythonSummary({
      className: "OP",
      methods: [{}, {}],
      members: [{}],
    } as never);
    expect(s).toEqual({
      className: "OP",
      displayName: "OP",
      category: "Unknown",
      methodCount: 2,
      memberCount: 1,
    });
  });

  it("toPythonSummary handles missing lists and uses provided displayName/category", () => {
    const s = toPythonSummary({
      className: "OP",
      displayName: "Operator",
      category: "Core",
    } as never);
    expect(s.methodCount).toBe(0);
    expect(s.memberCount).toBe(0);
    expect(s.displayName).toBe("Operator");
    expect(s.category).toBe("Core");
  });

  it("toTutorialSummary uses summary then description fallback", () => {
    expect(toTutorialSummary({ id: "t1", name: "Tut", description: "desc" } as never)).toEqual({
      id: "t1",
      name: "Tut",
      category: "Unknown",
      summary: "desc",
    });
    expect(
      toTutorialSummary({
        id: "t2",
        name: "Tut2",
        category: "Beginner",
        summary: "sum",
      } as never),
    ).toEqual({ id: "t2", name: "Tut2", category: "Beginner", summary: "sum" });
  });
});

describe("knowledge/normalize normalizePatterns", () => {
  it("handles array input", () => {
    const out = normalizePatterns([
      { name: "Feedback Loop", description: "d", workflow: ["a", "b"] },
      { name: "Bad" }, // no description
      { description: "no name" }, // filtered
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      id: "feedback_loop",
      name: "Feedback Loop",
      workflow: ["a", "b"],
    });
    expect(out[1]?.workflow).toBeUndefined();
  });

  it("handles { patterns: [...] } shape", () => {
    const out = normalizePatterns({ patterns: [{ name: "P" }], meta: "ignored" });
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe("p");
  });

  it("falls back to Object.values for unknown object shape", () => {
    const out = normalizePatterns({
      one: { name: "One" },
      two: { name: "Two", category: "cat" },
      bad: null,
    });
    expect(out.map((p) => p.id).sort()).toEqual(["one", "two"]);
    expect(out.find((p) => p.id === "two")?.category).toBe("cat");
  });

  it("returns empty for null/string input", () => {
    expect(normalizePatterns(null)).toEqual([]);
    expect(normalizePatterns("nope")).toEqual([]);
  });
});

describe("knowledge/normalize normalizeGlsl", () => {
  it("returns empty for missing/non-object", () => {
    expect(normalizeGlsl(null)).toEqual([]);
    expect(normalizeGlsl({})).toEqual([]);
    expect(normalizeGlsl({ techniques: "x" })).toEqual([]);
  });

  it("maps techniques and assigns id from slug when missing", () => {
    const out = normalizeGlsl({
      techniques: [
        null,
        "skip",
        {
          name: "Edge Blur",
          subcategory: "post",
          description: "d",
          difficulty: "easy",
          operators: ["glslTOP"],
          tags: ["blur"],
          notes: "n",
          code: { vertex: "v", fragment: "f" },
          setup: "s",
        },
        { id: "custom_id", name: "Other" },
        {},
      ],
    });
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({
      id: "edge_blur",
      name: "Edge Blur",
      subcategory: "post",
      difficulty: "easy",
      operators: ["glslTOP"],
      tags: ["blur"],
      setup: "s",
    });
    expect(out[1]?.id).toBe("custom_id");
    expect(out[2]?.name).toBe("Untitled");
    expect(out[2]?.id).toBe("untitled");
  });
});
