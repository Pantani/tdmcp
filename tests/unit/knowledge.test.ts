import { describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";

const kb = new KnowledgeBase();

describe("KnowledgeBase", () => {
  it("loads operators and exposes categories", () => {
    const stats = kb.stats();
    expect(stats.source).not.toBe("empty");
    expect(stats.operators).toBeGreaterThan(500);
    expect(kb.listOperatorCategories()).toContain("TOP");
  });

  it("resolves an operator by display name, slug, and type string", () => {
    expect(kb.getOperator("Noise TOP")?.category).toBe("TOP");
    expect(kb.getOperator("noise_top")?.name).toBe("Noise TOP");
    expect(kb.getOperator("noiseTOP")?.name).toBe("Noise TOP");
  });

  it("operatorExists is format-insensitive and soft", () => {
    expect(kb.operatorExists("noiseTOP")).toBe(true);
    expect(kb.operatorExists("definitely_not_real_op")).toBe(false);
  });

  it("searches operators by keyword", () => {
    const hits = kb.searchOperators("noise");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.name.toLowerCase().includes("noise"))).toBe(true);
  });

  it("lists python classes, patterns, glsl techniques and tutorials", () => {
    expect(kb.listPythonClasses().length).toBeGreaterThan(10);
    expect(kb.listPatterns().length).toBeGreaterThan(0);
    expect(kb.listGlslPatterns().length).toBeGreaterThan(0);
    expect(kb.listTutorials().length).toBeGreaterThan(0);
  });
});
