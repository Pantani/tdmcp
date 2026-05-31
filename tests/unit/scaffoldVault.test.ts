import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import type { ToolContext } from "../../src/tools/types.js";
import { scaffoldVaultImpl } from "../../src/tools/vault/scaffoldVault.js";
import { silentLogger } from "../../src/utils/logger.js";
import { Vault } from "../../src/vault/index.js";

function ctxWith(vault: Vault): ToolContext {
  return {
    client: new TouchDesignerClient({ baseUrl: "http://127.0.0.1:1", timeoutMs: 500 }),
    knowledge: new KnowledgeBase(),
    recipes: new RecipeLibrary({ vault }),
    logger: silentLogger,
    vault,
  };
}

describe("scaffold_vault", () => {
  it("writes a starter layout whose example recipe is loadable", () => {
    const dir = mkdtempSync(join(tmpdir(), "tdmcp-scaffold-"));
    try {
      const vault = new Vault(dir);
      scaffoldVaultImpl(ctxWith(vault), { overwrite: false });

      for (const rel of [
        "README.md",
        "Recipes/example_glow.md",
        "Setlists/example-set.md",
        "Shaders/example-plasma.md",
        "Moodboards/sunset.md",
      ]) {
        expect(vault.exists(rel)).toBe(true);
      }
      // the scaffolded recipe round-trips back through the loader
      expect(new RecipeLibrary({ vault }).get("example_glow")?.name).toBe("Example Glow");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("seeds the Memory/ folder with a style.md note and a README", () => {
    const dir = mkdtempSync(join(tmpdir(), "tdmcp-scaffold-mem-"));
    try {
      const vault = new Vault(dir);
      scaffoldVaultImpl(ctxWith(vault), { overwrite: false });
      expect(vault.exists("Memory/README.md")).toBe(true);
      expect(vault.exists("Memory/style.md")).toBe(true);
      const note = vault.readNote("Memory/style.md");
      expect(note.data.type).toBe("tdmcp-memory");
      expect(note.data.topic).toBe("style");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips existing files unless overwrite is set", () => {
    const dir = mkdtempSync(join(tmpdir(), "tdmcp-scaffold-"));
    try {
      const vault = new Vault(dir);
      scaffoldVaultImpl(ctxWith(vault), { overwrite: false });
      const res = scaffoldVaultImpl(ctxWith(vault), { overwrite: false });
      const data = JSON.parse(
        /```json\n([\s\S]*?)\n```/.exec((res.content[0] as { text: string }).text)?.[1] ?? "{}",
      );
      expect(data.created).toEqual([]);
      expect(data.skipped.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
