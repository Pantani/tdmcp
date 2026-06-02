import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { recipeFromMarkdown, recipeToMarkdown } from "../../src/recipes/markdown.js";
import { RecipeSchema } from "../../src/recipes/schema.js";
import { Vault } from "../../src/vault/index.js";

/**
 * Vault round-trip determinism.
 *
 * Proves offline that a recipe survives the full vault path:
 *   Recipe (object) → recipeToMarkdown → Vault.write (filesystem)
 *      → Vault.read → recipeFromMarkdown → RecipeSchema.parse → Recipe
 * and equals the original. Also proves the markdown bytes are deterministic
 * for the same input.
 *
 * The bridge is never touched: serialization/parse are pure, and apply_recipe's
 * "value equals another node's name → that node's path" rule is a build-time
 * resolution (in NetworkBuilder), so the recipe-on-disk simply stores the
 * literal node name string — which is exactly what we round-trip here.
 */

// Fixture: a small but representative recipe. Includes:
//  - >1 node with non-default parameters
//  - 1 connection
//  - 1 exposed parameter whose `value` is the *name of another node* (the
//    documented "value resolution" case — preserved verbatim by the codec).
//  - python_code (text-DAT body) so we also exercise that map
const ORIGINAL = RecipeSchema.parse({
  id: "round_trip_demo",
  name: "Round Trip Demo",
  description: "Tiny fixture used to assert vault round-trip determinism.",
  tags: ["test", "round-trip"],
  difficulty: "beginner",
  nodes: [
    { name: "noise1", type: "noiseTOP", parameters: { period: 4, amp: 0.5 } },
    { name: "level1", type: "levelTOP", parameters: { opacity: 0.8 } },
    { name: "out1", type: "nullTOP" },
  ],
  connections: [
    { from: "noise1", to: "level1" },
    { from: "level1", to: "out1" },
  ],
  parameters: [
    // The "value resolution" case: caller exposes a control whose target
    // value references another recipe node by NAME ("noise1"). The recipe
    // stores it as-is; resolution to a real TD path happens at apply time.
    { name: "Source", node: "level1", param: "source", value: "noise1" },
    { name: "Period", node: "noise1", param: "period", value: 4, min: 0, max: 16 },
  ],
  python_code: {
    out1: "# placeholder text DAT body\nop('noise1').par.period = 8\n",
  },
});

describe("vault round-trip determinism", () => {
  it("is deterministic: same recipe serializes to identical markdown bytes", () => {
    const a = recipeToMarkdown(ORIGINAL);
    const b = recipeToMarkdown(ORIGINAL);
    expect(a).toBe(b);
  });

  it("round-trips through markdown without losing or mutating any field", () => {
    const md = recipeToMarkdown(ORIGINAL);
    const back = recipeFromMarkdown(md);
    expect(back).toEqual(ORIGINAL);
  });

  it("round-trips through the filesystem-backed Vault and re-serializes identically", () => {
    const dir = mkdtempSync(join(tmpdir(), "tdmcp-vault-roundtrip-"));
    try {
      const vault = new Vault(dir);
      const rel = "Recipes/round_trip_demo.md";

      // Write
      const md1 = recipeToMarkdown(ORIGINAL);
      vault.write(rel, md1);
      expect(vault.exists(rel)).toBe(true);

      // Read back as raw bytes — must equal what we wrote.
      const md2 = vault.read(rel);
      expect(md2).toBe(md1);

      // Parse back to a Recipe — must equal the original.
      const parsed = recipeFromMarkdown(md2);
      expect(parsed).toEqual(ORIGINAL);

      // Re-serializing the parsed recipe must yield the same bytes again
      // (fixed-point determinism — important for git-friendly vaults).
      expect(recipeToMarkdown(parsed)).toBe(md1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves the 'value = other node name' parameter exactly (build-time resolution)", () => {
    const back = recipeFromMarkdown(recipeToMarkdown(ORIGINAL));
    const sourceParam = back.parameters.find((p) => p.name === "Source");
    expect(sourceParam).toBeDefined();
    // The recipe on disk stores the literal node name; NetworkBuilder resolves
    // it to a real TD path at apply time. The codec must NOT eagerly resolve.
    expect(sourceParam?.value).toBe("noise1");
    expect(sourceParam?.node).toBe("level1");
    expect(sourceParam?.param).toBe("source");
  });

  it("RecipeLibrary loads the vault note and surfaces it under its id", () => {
    const dir = mkdtempSync(join(tmpdir(), "tdmcp-vault-roundtrip-lib-"));
    try {
      const vault = new Vault(dir);
      vault.write("Recipes/round_trip_demo.md", recipeToMarkdown(ORIGINAL));

      const lib = new RecipeLibrary({ vault });
      const loaded = lib.get("round_trip_demo");
      expect(loaded).toBeDefined();
      // Full structural equality — proves the loader path is also lossless.
      expect(loaded).toEqual(ORIGINAL);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
