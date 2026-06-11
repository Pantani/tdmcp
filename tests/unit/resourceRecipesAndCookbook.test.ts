import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import {
  cookbookPathFromModuleDir,
  readCookbookResource,
  readCookbookResourceFromPath,
  registerCookbookResource,
} from "../../src/resources/cookbookResource.js";
import {
  registerRecipeResource,
  searchRecipeSummaries,
} from "../../src/resources/recipeResource.js";

let tempDirs: string[] = [];

afterEach(() => {
  const dirs = tempDirs;
  tempDirs = [];
  for (const dir of dirs) rmSync(dir, { force: true, recursive: true });
});

describe("recipe search resource helpers", () => {
  it("searches recipes by keyword across id, name, description and tags", () => {
    const recipes = new RecipeLibrary();
    const result = searchRecipeSummaries(recipes, "feedback");

    expect(result.query).toBe("feedback");
    expect(result.count).toBeGreaterThan(0);
    expect(
      result.recipes.some((recipe) =>
        [recipe.id, recipe.name, recipe.description, ...(recipe.tags ?? [])]
          .join(" ")
          .toLowerCase()
          .includes("feedback"),
      ),
    ).toBe(true);
  });

  it("returns a JSON error payload for malformed encoded search queries", async () => {
    const calls: Array<{
      name: string;
      handler: (
        uri: URL,
        variables?: Record<string, string>,
      ) => Promise<{
        contents: Array<{ text?: string }>;
      }>;
    }> = [];
    const server = {
      registerResource: (
        name: string,
        _uriOrTemplate: unknown,
        _metadata: unknown,
        handler: (
          uri: URL,
          variables?: Record<string, string>,
        ) => Promise<{
          contents: Array<{ text?: string }>;
        }>,
      ) => {
        calls.push({ name, handler });
      },
    };

    registerRecipeResource(server as never, { recipes: new RecipeLibrary() } as never);

    const search = calls.find((call) => call.name === "td-recipes-search");
    const result = await search?.handler(new URL("tdmcp://recipes/search/%GG"), { query: "%GG" });
    const payload = JSON.parse(result?.contents[0]?.text ?? "{}");

    expect(payload).toEqual({
      error: "Invalid query encoding.",
      query: "%GG",
    });
  });
});

describe("cookbook resource helpers", () => {
  it("reads the English prompt cookbook as a compact MCP resource payload", () => {
    const result = readCookbookResource("en");

    expect(result.locale).toBe("en");
    expect(result.title.toLowerCase()).toContain("prompt cookbook");
    expect(result.text).toContain("tdmcp");
    expect(result.bytes).toBeGreaterThan(1000);
  });

  it("reads the Portuguese prompt cookbook separately", () => {
    const result = readCookbookResource("pt");

    expect(result.locale).toBe("pt");
    expect(result.title.toLowerCase()).toContain("prompt");
    expect(result.text).toContain("tdmcp");
  });

  it("returns an explanatory payload instead of throwing when the cookbook file is missing", () => {
    const result = readCookbookResourceFromPath("pt", "/tmp/tdmcp-missing-cookbook.md");

    expect(result.locale).toBe("pt");
    expect(result.title).toBe("Livro de Receitas de Prompts");
    expect(result.bytes).toBe(0);
    expect(result.text).toBe("");
    expect(result.error).toContain("Could not read prompt cookbook");
  });

  it("resolves the cookbook from the package root when running from bundled dist", () => {
    const parent = mkdtempSync(join(tmpdir(), "tdmcp-cookbook-root-"));
    tempDirs.push(parent);

    const packageRoot = join(parent, "tdmcp");
    const moduleDir = join(packageRoot, "dist");
    const parentCookbook = join(parent, "docs", "guide", "prompt-cookbook.md");
    const packageCookbook = join(packageRoot, "docs", "guide", "prompt-cookbook.md");

    mkdirSync(join(parent, "docs", "guide"), { recursive: true });
    mkdirSync(join(packageRoot, "docs", "guide"), { recursive: true });
    mkdirSync(moduleDir, { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "tdmcp" }));
    writeFileSync(parentCookbook, "# Wrong Cookbook");
    writeFileSync(packageCookbook, "# Prompt Cookbook");

    expect(cookbookPathFromModuleDir("en", moduleDir)).toBe(packageCookbook);
  });

  it("declares JSON mime types to match the returned cookbook payload", async () => {
    const calls: Array<{
      name: string;
      metadata: { mimeType?: string };
      handler: (
        uri: URL,
        variables?: Record<string, string>,
      ) => Promise<{
        contents: Array<{ mimeType?: string }>;
      }>;
    }> = [];
    const server = {
      registerResource: (
        name: string,
        _uriOrTemplate: unknown,
        metadata: { mimeType?: string },
        handler: (
          uri: URL,
          variables?: Record<string, string>,
        ) => Promise<{
          contents: Array<{ mimeType?: string }>;
        }>,
      ) => {
        calls.push({ name, metadata, handler });
      },
    };

    registerCookbookResource(server as never, {} as never);

    expect(calls.map((call) => call.metadata.mimeType)).toEqual([
      "application/json",
      "application/json",
    ]);
    const result = await calls[0]?.handler(new URL("tdmcp://cookbook"));
    expect(result?.contents[0]?.mimeType).toBe("application/json");
  });
});
