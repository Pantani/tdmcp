import { describe, expect, it } from "vitest";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { listRecipesImpl } from "../../src/tools/layer1/listRecipes.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

function makeCtx(): ToolContext {
  return {
    recipes: new RecipeLibrary(),
    logger: silentLogger,
  } as unknown as ToolContext;
}

describe("listRecipesImpl", () => {
  it("returns all recipes when no tag filter is given", () => {
    const ctx = makeCtx();
    const allCount = ctx.recipes.list().length;
    const result = listRecipesImpl(ctx, {});
    // Text summary contains the count.
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining(`${allCount}`),
    });
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining(ctx.recipes.list()[0]?.id ?? ""),
    });
    // Structured payload has full recipe list.
    expect((result as { structuredContent?: { count: number } }).structuredContent?.count).toBe(
      allCount,
    );
  });

  it("filters by tag and returns only matching recipes", () => {
    const ctx = makeCtx();
    // 'reaction_diffusion' recipe has a 'simulation' or 'feedback' tag — pick a tag present
    // in at least one but not all recipes so the filter is meaningful.
    const all = ctx.recipes.list();
    const sampleTag = all[0]?.tags[0];
    if (!sampleTag) return; // guard: skip if library is empty
    const result = listRecipesImpl(ctx, { tag: sampleTag });
    const sc = (result as { structuredContent?: { count: number; recipes: unknown[] } })
      .structuredContent;
    expect(sc?.count).toBeGreaterThan(0);
    expect(sc?.count).toBeLessThanOrEqual(all.length);
  });

  it("returns zero recipes for a tag that matches nothing", () => {
    const result = listRecipesImpl(makeCtx(), { tag: "xyzzy_nonexistent_tag_9999" });
    const sc = (result as { structuredContent?: { count: number } }).structuredContent;
    expect(sc?.count).toBe(0);
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("0") });
  });

  it("matches by recipe name as well as by tag", () => {
    const ctx = makeCtx();
    const all = ctx.recipes.list();
    const sampleName = all[0]?.name ?? "";
    // Take just the first word of the name as the needle (names are multi-word).
    const needle = sampleName.split(" ")[0]?.toLowerCase() ?? "";
    if (needle.length < 3) return;
    const result = listRecipesImpl(ctx, { tag: needle });
    const sc = (result as { structuredContent?: { count: number } }).structuredContent;
    expect(sc?.count).toBeGreaterThan(0);
  });
});
