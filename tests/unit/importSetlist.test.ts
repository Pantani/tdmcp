import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { recipeToMarkdown } from "../../src/recipes/markdown.js";
import { RecipeSchema } from "../../src/recipes/schema.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import type { ToolContext } from "../../src/tools/types.js";
import { importSetlistImpl } from "../../src/tools/vault/importSetlist.js";
import { silentLogger } from "../../src/utils/logger.js";
import { Vault } from "../../src/vault/index.js";

function ctxWith(vault: Vault): ToolContext {
  return {
    // dry_run never touches the client; the URL is intentionally unreachable.
    client: new TouchDesignerClient({ baseUrl: "http://127.0.0.1:1", timeoutMs: 500 }),
    knowledge: new KnowledgeBase(),
    recipes: new RecipeLibrary({ vault }),
    logger: silentLogger,
    vault,
  };
}

function jsonOf(text: string): { built: Array<{ recipe: string }>; skipped: unknown[] } {
  const match = /```json\n([\s\S]*?)\n```/.exec(text);
  if (!match?.[1]) throw new Error(`no json block in: ${text}`);
  return JSON.parse(match[1]);
}

describe("import_setlist (dry_run)", () => {
  it("resolves tracks against vault + built-in recipes without touching TD", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tdmcp-setlist-"));
    try {
      const vault = new Vault(dir);
      const demo = RecipeSchema.parse({
        id: "vault_demo",
        name: "Vault Demo",
        nodes: [{ name: "n", type: "nullTOP" }],
      });
      vault.write("Recipes/vault_demo.md", recipeToMarkdown(demo));
      vault.writeNote(
        "Setlists/show.md",
        {
          tracks: [
            "vault_demo",
            "feedback_tunnel",
            { title: "ghost", recipe: "does_not_exist" },
            { title: "manual", preset: "p1" },
          ],
        },
        "my show",
      );

      const res = await importSetlistImpl(ctxWith(vault), {
        note: "show",
        parent_path: "/project1",
        dry_run: true,
      });
      const data = jsonOf((res.content[0] as { text: string }).text);
      expect(data.built.map((b) => b.recipe).sort()).toEqual(["feedback_tunnel", "vault_demo"]);
      expect(data.skipped).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts the new scenes[] frontmatter shape (dry_run)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tdmcp-setlist-"));
    try {
      const vault = new Vault(dir);
      const demo = RecipeSchema.parse({
        id: "vault_demo",
        name: "Vault Demo",
        nodes: [{ name: "n", type: "nullTOP" }],
      });
      vault.write("Recipes/vault_demo.md", recipeToMarkdown(demo));
      vault.writeNote(
        "Setlists/show_scenes.md",
        {
          scenes: [
            { id: "opener", title: "Opener", recipe: "vault_demo" },
            { id: "drop", title: "Drop", cue: "drop_cue" },
            { id: "outro", title: "Outro", preset: "calm" },
          ],
        },
        "scenes show",
      );

      const res = await importSetlistImpl(ctxWith(vault), {
        note: "show_scenes",
        parent_path: "/project1",
        dry_run: true,
      });
      const data = jsonOf((res.content[0] as { text: string }).text);
      expect(data.built.map((b) => b.recipe)).toEqual(["vault_demo"]);
      expect(data.skipped).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("errors when the note has no tracks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tdmcp-setlist-"));
    try {
      const vault = new Vault(dir);
      vault.writeNote("Setlists/empty.md", { title: "no tracks" }, "nothing here");
      const res = await importSetlistImpl(ctxWith(vault), {
        note: "empty",
        parent_path: "/project1",
        dry_run: true,
      });
      expect(res.isError).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
