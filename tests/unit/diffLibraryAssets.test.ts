import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import {
  diffLibraryAssetsImpl,
  diffLibraryAssetsSchema,
} from "../../src/tools/library/diffLibraryAssets.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

function makeCtx(): ToolContext {
  return {
    // The tool is pure-offline (filesystem only); the client is never touched.
    client: undefined as unknown as ToolContext["client"],
    knowledge: new KnowledgeBase(),
    recipes: new RecipeLibrary(),
    logger: silentLogger,
  };
}

interface DiffResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
  structuredContent?: {
    a_path: string;
    b_path: string;
    mode_used: "recipe" | "manifest" | "json";
    summary: { added: number; removed: number; changed: number };
    details: {
      deep: {
        added: Array<{ path: string; value: unknown }>;
        removed: Array<{ path: string; value: unknown }>;
        changed: Array<{ path: string; old: unknown; new: unknown }>;
      };
      recipe?: {
        nodes_added: string[];
        nodes_removed: string[];
        params_changed: Array<{ node: string; param: string; old: unknown; new: unknown }>;
        connections_added: string[];
        connections_removed: string[];
      };
    };
  };
}

let dir: string;

function writeJson(name: string, data: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(data, null, 2), "utf8");
  return path;
}

function sampleRecipe(
  overrides: {
    sourcePeriod?: number;
    extraNode?: { name: string; type: string; parameters: Record<string, unknown> };
  } = {},
): Record<string, unknown> {
  const nodes: Array<Record<string, unknown>> = [
    { name: "source", type: "noiseTOP", parameters: { period: overrides.sourcePeriod ?? 4 } },
    { name: "out1", type: "nullTOP", parameters: {} },
  ];
  if (overrides.extraNode) nodes.push(overrides.extraNode);
  return {
    id: "demo.diff",
    name: "Demo Diff Recipe",
    description: "A recipe for diff testing.",
    tags: ["test"],
    difficulty: "beginner",
    nodes,
    connections: [{ from: "source", to: "out1" }],
    parameters: [],
    controls: [],
    preview_description: "demo",
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tdmcp-diff-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("diff_library_assets", () => {
  it("schema defaults mode to auto", () => {
    expect(diffLibraryAssetsSchema.parse({ a_path: "a.json", b_path: "b.json" }).mode).toBe("auto");
  });

  it("reports zero changes for identical files", async () => {
    const a = writeJson("a.json", { foo: 1, bar: ["x", "y"], nested: { k: true } });
    const b = writeJson("b.json", { foo: 1, bar: ["x", "y"], nested: { k: true } });
    const res = (await diffLibraryAssetsImpl(makeCtx(), {
      a_path: a,
      b_path: b,
      mode: "json",
    })) as DiffResult;
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent?.summary).toEqual({ added: 0, removed: 0, changed: 0 });
    expect(res.content[0]?.text).toBe("0 changed, 0 added, 0 removed");
  });

  it("reports a changed value with old and new", async () => {
    const a = writeJson("a.json", { foo: 1, keep: "same" });
    const b = writeJson("b.json", { foo: 2, keep: "same" });
    const res = (await diffLibraryAssetsImpl(makeCtx(), {
      a_path: a,
      b_path: b,
      mode: "auto",
    })) as DiffResult;
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent?.summary.changed).toBe(1);
    const changed = res.structuredContent?.details.deep.changed ?? [];
    expect(changed).toContainEqual({ path: "foo", old: 1, new: 2 });
    expect(res.structuredContent?.mode_used).toBe("json");
  });

  it("reports a removed key (present in a, absent in b)", async () => {
    const a = writeJson("a.json", { gone: "bye", stay: 1 });
    const b = writeJson("b.json", { stay: 1 });
    const res = (await diffLibraryAssetsImpl(makeCtx(), {
      a_path: a,
      b_path: b,
      mode: "json",
    })) as DiffResult;
    expect(res.structuredContent?.summary.removed).toBe(1);
    expect(res.structuredContent?.details.deep.removed).toContainEqual({
      path: "gone",
      value: "bye",
    });
  });

  it("reports an added key (absent in a, present in b)", async () => {
    const a = writeJson("a.json", { stay: 1 });
    const b = writeJson("b.json", { stay: 1, fresh: [1, 2, 3] });
    const res = (await diffLibraryAssetsImpl(makeCtx(), {
      a_path: a,
      b_path: b,
      mode: "json",
    })) as DiffResult;
    expect(res.structuredContent?.summary.added).toBe(1);
    expect(res.structuredContent?.details.deep.added).toContainEqual({
      path: "fresh",
      value: [1, 2, 3],
    });
  });

  it("reports manifest mode distinctly while using the generic deep diff", async () => {
    const a = writeJson("a.manifest.json", { id: "demo", version: "1.0.0", assets: ["a.tox"] });
    const b = writeJson("b.manifest.json", {
      id: "demo",
      version: "1.1.0",
      assets: ["a.tox", "thumb.png"],
    });

    const res = (await diffLibraryAssetsImpl(makeCtx(), {
      a_path: a,
      b_path: b,
      mode: "manifest",
    })) as DiffResult;

    expect(res.isError).toBeFalsy();
    expect(res.structuredContent?.mode_used).toBe("manifest");
    expect(res.structuredContent?.details.deep.changed).toContainEqual({
      path: "version",
      old: "1.0.0",
      new: "1.1.0",
    });
    expect(res.structuredContent?.details.deep.added).toContainEqual({
      path: "assets[1]",
      value: "thumb.png",
    });
  });

  it("returns an isError result for a missing path and never throws", async () => {
    const a = writeJson("a.json", { foo: 1 });
    const res = (await diffLibraryAssetsImpl(makeCtx(), {
      a_path: a,
      b_path: join(dir, "does-not-exist.json"),
      mode: "auto",
    })) as DiffResult;
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("File not found");
  });

  it("returns an isError result for invalid JSON and never throws", async () => {
    const a = writeJson("a.json", { foo: 1 });
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{ not: valid json", "utf8");
    const res = (await diffLibraryAssetsImpl(makeCtx(), {
      a_path: a,
      b_path: bad,
      mode: "json",
    })) as DiffResult;
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("Invalid JSON");
  });

  it("recipe mode detects a node param change", async () => {
    const a = writeJson("a.json", sampleRecipe({ sourcePeriod: 4 }));
    const b = writeJson("b.json", sampleRecipe({ sourcePeriod: 8 }));
    const res = (await diffLibraryAssetsImpl(makeCtx(), {
      a_path: a,
      b_path: b,
      mode: "recipe",
    })) as DiffResult;
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent?.mode_used).toBe("recipe");
    const params = res.structuredContent?.details.recipe?.params_changed ?? [];
    expect(params).toContainEqual({ node: "source", param: "period", old: 4, new: 8 });
  });

  it("auto mode picks recipe diffing and detects an added node", async () => {
    const a = writeJson("a.json", sampleRecipe());
    const b = writeJson(
      "b.json",
      sampleRecipe({ extraNode: { name: "blur", type: "blurTOP", parameters: {} } }),
    );
    const res = (await diffLibraryAssetsImpl(makeCtx(), {
      a_path: a,
      b_path: b,
      mode: "auto",
    })) as DiffResult;
    expect(res.structuredContent?.mode_used).toBe("recipe");
    expect(res.structuredContent?.details.recipe?.nodes_added).toContain("blur");
  });

  it("recipe mode requested on non-recipe JSON returns an isError result", async () => {
    const a = writeJson("a.json", { not: "a recipe" });
    const b = writeJson("b.json", { also: "not" });
    const res = (await diffLibraryAssetsImpl(makeCtx(), {
      a_path: a,
      b_path: b,
      mode: "recipe",
    })) as DiffResult;
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("recipe schema");
  });
});
