import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { generativeClassicsPackImpl } from "../../src/tools/library/generativeClassicsPack.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}
function jsonOf<T = Record<string, unknown>>(result: CallToolResult): T {
  const m = /```json\n([\s\S]*?)\n```/.exec(textOf(result));
  return JSON.parse(m?.[1] ?? "{}") as T;
}

const tmpDirs: string[] = [];
function tmpOutDir(): string {
  const d = mkdtempSync(join(tmpdir(), "tdmcp-classics-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

function ctxWith(recipes: RecipeLibrary): ToolContext {
  return { logger: silentLogger, recipes } as unknown as ToolContext;
}

describe("generativeClassicsPackImpl", () => {
  it("list_only returns the technique cards and reports availability", async () => {
    const ctx = ctxWith(new RecipeLibrary());
    const result = await generativeClassicsPackImpl(ctx, {
      list_only: true,
      overwrite: false,
    });
    expect(result.isError).toBeFalsy();
    const data = jsonOf<{
      total: number;
      available: number;
      techniques: Array<{ technique_id: string; available: boolean; category: string }>;
    }>(result);
    expect(data.total).toBe(6);
    expect(data.techniques.length).toBe(6);
    // The real recipe library ships these — they should be available.
    expect(data.available).toBeGreaterThanOrEqual(5);
    expect(data.techniques.map((t) => t.technique_id)).toEqual(
      expect.arrayContaining([
        "feedback_tunnel",
        "audio_spectrum_bars",
        "noise_landscape",
        "particle_galaxy",
        "reaction_diffusion",
        "webcam_glitch",
      ]),
    );
  });

  it("list_only:false writes a bundle JSON at install_path", async () => {
    const ctx = ctxWith(new RecipeLibrary());
    const out = join(tmpOutDir(), "pack.json");
    const result = await generativeClassicsPackImpl(ctx, {
      list_only: false,
      install_path: out,
      overwrite: false,
    });
    expect(result.isError).toBeFalsy();
    expect(existsSync(out)).toBe(true);
    const bundle = JSON.parse(readFileSync(out, "utf8")) as {
      kind: string;
      pack_id: string;
      recipes: Array<{ id: string }>;
    };
    expect(bundle.kind).toBe("tdmcp-recipe-bundle");
    expect(bundle.pack_id).toBe("generative_classics");
    expect(bundle.recipes.length).toBeGreaterThanOrEqual(5);
  });

  it("refuses to overwrite an existing file without overwrite:true", async () => {
    const ctx = ctxWith(new RecipeLibrary());
    const out = join(tmpOutDir(), "pack.json");
    let r = await generativeClassicsPackImpl(ctx, {
      list_only: false,
      install_path: out,
      overwrite: false,
    });
    expect(r.isError).toBeFalsy();
    r = await generativeClassicsPackImpl(ctx, {
      list_only: false,
      install_path: out,
      overwrite: false,
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("already exists");
    // With overwrite, it works.
    r = await generativeClassicsPackImpl(ctx, {
      list_only: false,
      install_path: out,
      overwrite: true,
    });
    expect(r.isError).toBeFalsy();
  });

  it("errors with a friendly message when no recipes are available", async () => {
    // Empty recipe library (point loader at a fake empty dir).
    const empty = mkdtempSync(join(tmpdir(), "tdmcp-no-recipes-"));
    tmpDirs.push(empty);
    const ctx = ctxWith(new RecipeLibrary({ dir: empty }));
    const out = join(tmpOutDir(), "pack.json");
    const result = await generativeClassicsPackImpl(ctx, {
      list_only: false,
      install_path: out,
      overwrite: false,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("No generative-classics recipes");
  });
});
