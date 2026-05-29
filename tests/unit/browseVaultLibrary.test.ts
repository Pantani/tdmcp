import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// This tool is offline-only (no bridge call). We still include the msw boilerplate
// so the test runner satisfies onUnhandledRequest if anything slips through.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import type { ToolContext } from "../../src/tools/types.js";
import {
  browseVaultLibraryImpl,
  browseVaultLibrarySchema,
} from "../../src/tools/vault/browseVaultLibrary.js";
import { silentLogger } from "../../src/utils/logger.js";
import { Vault } from "../../src/vault/index.js";
import { makeTdServer } from "../helpers/tdMock.js";

const server = makeTdServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

/** Construct a ToolContext without a vault. */
function ctxNoVault(): ToolContext {
  return {
    client: new TouchDesignerClient({ baseUrl: "http://127.0.0.1:1", timeoutMs: 500 }),
    knowledge: new KnowledgeBase(),
    recipes: new RecipeLibrary(),
    logger: silentLogger,
  };
}

/** Construct a ToolContext with a temp vault, run the callback, clean up. */
function withVault(fn: (vault: Vault, ctx: ToolContext) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "tdmcp-browse-"));
  try {
    const vault = new Vault(dir);
    const ctx: ToolContext = {
      client: new TouchDesignerClient({ baseUrl: "http://127.0.0.1:1", timeoutMs: 500 }),
      knowledge: new KnowledgeBase(),
      recipes: new RecipeLibrary({ vault }),
      logger: silentLogger,
      vault,
    };
    fn(vault, ctx);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Seed a vault note with YAML frontmatter + optional body. */
function seedNote(vault: Vault, relPath: string, data: Record<string, unknown>, body = ""): void {
  vault.writeNote(relPath, data, body);
}

/** Extract structuredContent from a result (cast for test assertions). */
function structured(result: Awaited<ReturnType<typeof browseVaultLibraryImpl>>): {
  vault_path: string;
  items: Array<{ kind: string; title: string; path: string; tags: string[]; description?: string }>;
  counts: Record<string, number>;
  warnings: string[];
} {
  return (result as { structuredContent: unknown }).structuredContent as ReturnType<
    typeof structured
  >;
}

/** Extract text summary from a result. */
function textOf(result: Awaited<ReturnType<typeof browseVaultLibraryImpl>>): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

describe("browseVaultLibraryImpl", () => {
  // ---- requireVault guard ----
  it("returns isError when no vault is configured", async () => {
    const result = await browseVaultLibraryImpl(ctxNoVault(), {
      kinds: ["all"],
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("TDMCP_VAULT_PATH");
  });

  it("never throws on the no-vault path", async () => {
    await expect(
      browseVaultLibraryImpl(ctxNoVault(), { kinds: ["recipes"] }),
    ).resolves.toMatchObject({ isError: true });
  });

  // ---- happy path: counts and items correct across multiple categories ----
  it("happy path: counts and items correct across three categories", async () => {
    withVault((vault, ctx) => {
      seedNote(vault, "Recipes/aurora.md", { title: "Aurora", tags: ["ambient"] });
      seedNote(vault, "Shaders/plasma.md", { title: "Plasma", tags: ["glsl"] }, "A shader.");
      seedNote(vault, "Presets/show.md", { title: "Show Preset" });

      return (async () => {
        const result = await browseVaultLibraryImpl(ctx, { kinds: ["all"] });
        expect(result.isError).toBeFalsy();

        const data = structured(result);
        expect(data.vault_path).toBeTruthy();
        expect(data.warnings).toEqual([]);

        const recipePaths = data.items.filter((i) => i.kind === "recipes").map((i) => i.path);
        expect(recipePaths).toContain("Recipes/aurora.md");
        expect(data.counts.recipes).toBe(1);

        const shaderPaths = data.items.filter((i) => i.kind === "shaders").map((i) => i.path);
        expect(shaderPaths).toContain("Shaders/plasma.md");
        expect(data.counts.shaders).toBe(1);

        expect(data.counts.presets).toBe(1);
        // categories with no notes have count 0
        expect(data.counts.components).toBe(0);
        expect(data.counts.setlists).toBe(0);

        // total summary mentions items and categories
        const summary = textOf(result);
        expect(summary).toContain("3 item(s)");
        expect(summary).toContain("3 categor");
      })();
    });
  });

  // ---- title fallback to filename stem ----
  it("uses filename stem as title when frontmatter has no title/name", async () => {
    withVault((vault, ctx) => {
      seedNote(vault, "Recipes/funky-beat.md", {}, "No frontmatter title here.");
      return (async () => {
        const result = await browseVaultLibraryImpl(ctx, { kinds: ["recipes"] });
        const data = structured(result);
        const item = data.items.find((i) => i.path === "Recipes/funky-beat.md");
        expect(item).toBeDefined();
        expect(item?.title).toBe("funky-beat");
      })();
    });
  });

  // ---- description fallback to first body line ----
  it("falls back to first body line when frontmatter description is absent", async () => {
    withVault((vault, ctx) => {
      seedNote(vault, "Shaders/wave.md", { title: "Wave" }, "Wavy sine wave effect.");
      return (async () => {
        const result = await browseVaultLibraryImpl(ctx, { kinds: ["shaders"] });
        const data = structured(result);
        const item = data.items.find((i) => i.path === "Shaders/wave.md");
        expect(item?.description).toBe("Wavy sine wave effect.");
      })();
    });
  });

  // ---- query filter ----
  it("query filters on title substring (case-insensitive)", async () => {
    withVault((vault, ctx) => {
      seedNote(vault, "Recipes/aurora.md", { title: "Aurora Borealis", tags: ["ambient"] });
      seedNote(vault, "Recipes/laser.md", { title: "Laser Grid", tags: ["techno"] });
      return (async () => {
        const result = await browseVaultLibraryImpl(ctx, {
          kinds: ["recipes"],
          query: "LASER",
        });
        const data = structured(result);
        expect(data.items).toHaveLength(1);
        expect(data.items[0]?.path).toBe("Recipes/laser.md");
      })();
    });
  });

  it("query filters on tag substring", async () => {
    withVault((vault, ctx) => {
      seedNote(vault, "Recipes/ambient.md", { title: "Drift", tags: ["ambient", "generative"] });
      seedNote(vault, "Recipes/techno.md", { title: "Techno", tags: ["bpm", "techno"] });
      return (async () => {
        const result = await browseVaultLibraryImpl(ctx, {
          kinds: ["recipes"],
          query: "generative",
        });
        const data = structured(result);
        expect(data.items).toHaveLength(1);
        expect(data.items[0]?.title).toBe("Drift");
      })();
    });
  });

  it("query with no match returns empty items and 0 counts", async () => {
    withVault((vault, ctx) => {
      seedNote(vault, "Recipes/glow.md", { title: "Glow" });
      return (async () => {
        const result = await browseVaultLibraryImpl(ctx, {
          kinds: ["recipes"],
          query: "zzz_no_match",
        });
        expect(result.isError).toBeFalsy();
        const data = structured(result);
        expect(data.items).toHaveLength(0);
        expect(data.counts.recipes).toBe(0);
        expect(textOf(result)).toContain("No items found");
      })();
    });
  });

  // ---- missing folder is silent (not a warning, vault.list returns []) ----
  it("missing folder does not throw — returns empty count for that category", async () => {
    withVault((vault, ctx) => {
      // Seed only Recipes — leave Components/ absent
      seedNote(vault, "Recipes/glow.md", { title: "Glow" });
      return (async () => {
        const result = await browseVaultLibraryImpl(ctx, { kinds: ["recipes", "components"] });
        expect(result.isError).toBeFalsy();
        const data = structured(result);
        expect(data.counts.recipes).toBe(1);
        expect(data.counts.components).toBe(0);
        expect(data.warnings).toHaveLength(0); // missing folder is not a warning, just empty
      })();
    });
  });

  // ---- specific kinds selection ----
  it("respects specific kinds selection (not all)", async () => {
    withVault((vault, ctx) => {
      seedNote(vault, "Recipes/glow.md", { title: "Glow" });
      seedNote(vault, "Shaders/plasma.md", { title: "Plasma" });
      return (async () => {
        const result = await browseVaultLibraryImpl(ctx, { kinds: ["shaders"] });
        const data = structured(result);
        // only shaders in counts
        expect(Object.keys(data.counts)).toEqual(["shaders"]);
        expect(data.items.every((i) => i.kind === "shaders")).toBe(true);
      })();
    });
  });

  // ---- schema defaults ----
  it("schema parses empty object and defaults kinds to ['all']", () => {
    const parsed = browseVaultLibrarySchema.parse({});
    expect(parsed.kinds).toEqual(["all"]);
    expect(parsed.query).toBeUndefined();
  });

  it("schema rejects an unknown kind value", () => {
    expect(() => browseVaultLibrarySchema.parse({ kinds: ["unknown_kind"] })).toThrow();
  });
});
