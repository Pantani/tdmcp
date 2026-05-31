import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import type { ToolContext } from "../../src/tools/types.js";
import { autoTagLibraryAssetImpl, suggestTags } from "../../src/tools/vault/autoTagLibraryAsset.js";
import { silentLogger } from "../../src/utils/logger.js";
import { Vault } from "../../src/vault/index.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

const server = makeTdServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function client(): TouchDesignerClient {
  return new TouchDesignerClient({ baseUrl: TD_BASE, timeoutMs: 2000 });
}
function ctxNoVault(): ToolContext {
  return { client: client(), logger: silentLogger } as unknown as ToolContext;
}
function ctxWith(vault: Vault): ToolContext {
  return { client: client(), logger: silentLogger, vault } as unknown as ToolContext;
}
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
function withVault(fn: (vault: Vault) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "tdmcp-autotag-"));
  return Promise.resolve(fn(new Vault(dir))).finally(() =>
    rmSync(dir, { recursive: true, force: true }),
  );
}
function mockCapture(report: Record<string, unknown>): void {
  server.use(
    http.post(`${TD_BASE}/api/exec`, () =>
      HttpResponse.json({ ok: true, data: { result: null, stdout: JSON.stringify(report) } }),
    ),
  );
}

// A minimal recipe note that recipeFromMarkdown can round-trip. The body must
// carry the ```json tdmcp-recipe fence, so we hand-author one.
function writeRecipeNote(
  vault: Vault,
  rel: string,
  opts: {
    id: string;
    tags?: string[];
    description?: string;
    nodes: Array<{ name: string; type: string }>;
    connections?: Array<{ from: string; to: string; from_output: number; to_input: number }>;
  },
): void {
  const recipe = {
    id: opts.id,
    name: opts.id,
    description: opts.description ?? "",
    tags: opts.tags ?? [],
    difficulty: "intermediate",
    nodes: opts.nodes.map((n) => ({
      name: n.name,
      type: n.type,
      parameters: {},
    })),
    connections: opts.connections ?? [],
  };
  // Use the vault.writeNote so frontmatter shape matches what parseNote reads back.
  const body = `Demo\n\n\`\`\`json tdmcp-recipe\n${JSON.stringify(recipe, null, 2)}\n\`\`\`\n`;
  vault.writeNote(
    rel,
    {
      id: opts.id,
      name: opts.id,
      description: opts.description ?? "",
      tags: opts.tags ?? [],
      difficulty: "intermediate",
      type: "tdmcp-recipe",
    },
    body,
  );
}

describe("suggestTags (pure heuristic)", () => {
  it("emits feedback + glsl + post-fx tags for a feedback/glsl network", () => {
    const out = suggestTags({
      nodes: [
        { name: "fb", type: "feedbackTOP" },
        { name: "g1", type: "glslTOP" },
        { name: "n1", type: "noiseTOP" },
        { name: "blur1", type: "blurTOP" },
        { name: "lvl", type: "levelTOP" },
      ],
      connections: [
        { from: "n1", to: "g1" },
        { from: "g1", to: "fb" },
        { from: "fb", to: "fb" }, // self-loop
      ],
    });
    expect(out.suggested_tags).toEqual(expect.arrayContaining(["feedback", "glsl", "post-fx"]));
    expect(["intermediate", "advanced"]).toContain(out.difficulty);
  });

  it("caps at max_tags and respects min_confidence", () => {
    const big: Array<{ name: string; type: string }> = [];
    for (let i = 0; i < 25; i++) big.push({ name: `n${i}`, type: "noiseTOP" });
    big.push({ name: "g", type: "glslTOP" }, { name: "fb", type: "feedbackTOP" });
    const out = suggestTags({ nodes: big, connections: [] }, undefined, {
      maxTags: 5,
      minConfidence: 0.3,
    });
    expect(out.suggested_tags.length).toBeLessThanOrEqual(5);
    expect(out.difficulty).toBe("advanced");
  });

  it("returns beginner for tiny non-complex networks", () => {
    const out = suggestTags({
      nodes: [
        { name: "n", type: "noiseTOP" },
        { name: "b", type: "blurTOP" },
      ],
      connections: [{ from: "n", to: "b" }],
    });
    expect(out.difficulty).toBe("beginner");
  });

  it("ignores unknown ops gracefully (no throw, no family tag)", () => {
    const out = suggestTags(
      {
        nodes: [
          { name: "x", type: "futureFakeTOP" },
          { name: "n", type: "noiseTOP" },
        ],
        connections: [],
      },
      // No KB → operatorExists is not called, so unknown ops still contribute family tags
      // via category rules only. Heuristic must NOT throw.
    );
    expect(out.suggested_tags).toBeDefined();
  });
});

describe("autoTagLibraryAssetImpl", () => {
  it("errors with a TDMCP_VAULT_PATH hint when no vault is configured", async () => {
    const result = await autoTagLibraryAssetImpl(ctxNoVault(), {
      target: "vault_note",
      note_path: "Recipes/x.md",
      comp_path: "/project1",
      category_hint: "auto",
      write: false,
      overwrite_existing_tags: false,
      max_tags: 8,
      min_confidence: 0.35,
      include_difficulty: true,
      include_description: true,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("TDMCP_VAULT_PATH");
  });

  it("vault_note dry-run: suggests feedback/glsl tags without writing", async () => {
    await withVault(async (vault) => {
      writeRecipeNote(vault, "Recipes/fb.md", {
        id: "fb",
        nodes: [
          { name: "fb", type: "feedbackTOP" },
          { name: "g", type: "glslTOP" },
          { name: "n", type: "noiseTOP" },
        ],
      });
      const before = vault.read("Recipes/fb.md");
      const result = await autoTagLibraryAssetImpl(ctxWith(vault), {
        target: "vault_note",
        note_path: "Recipes/fb.md",
        comp_path: "/project1",
        category_hint: "auto",
        write: false,
        overwrite_existing_tags: false,
        max_tags: 8,
        min_confidence: 0.35,
        include_difficulty: true,
        include_description: true,
      });
      expect(result.isError).toBeFalsy();
      const data = jsonOf<{ suggested_tags: string[]; written: boolean }>(result);
      expect(data.written).toBe(false);
      expect(data.suggested_tags).toEqual(expect.arrayContaining(["feedback", "glsl"]));
      // Vault must be untouched in dry-run.
      expect(vault.read("Recipes/fb.md")).toBe(before);
    });
  });

  it("vault_note write:true: merges tags into frontmatter and preserves *user tag", async () => {
    await withVault(async (vault) => {
      writeRecipeNote(vault, "Recipes/fb.md", {
        id: "fb",
        tags: ["*neon", "existing"],
        nodes: [
          { name: "fb", type: "feedbackTOP" },
          { name: "g", type: "glslTOP" },
          { name: "n", type: "noiseTOP" },
        ],
      });
      const result = await autoTagLibraryAssetImpl(ctxWith(vault), {
        target: "vault_note",
        note_path: "Recipes/fb.md",
        comp_path: "/project1",
        category_hint: "auto",
        write: true,
        overwrite_existing_tags: false,
        max_tags: 8,
        min_confidence: 0.35,
        include_difficulty: true,
        include_description: true,
      });
      expect(result.isError).toBeFalsy();
      const after = vault.readNote("Recipes/fb.md");
      const tags = after.data.tags as string[];
      expect(tags).toEqual(expect.arrayContaining(["*neon", "feedback", "glsl", "existing"]));
      const autoTags = after.data.auto_tags as { source: string };
      expect(autoTags.source).toBe("auto_tag_library_asset");
    });
  });

  it("overwrite_existing_tags:true drops non-pinned existing tags but keeps *user", async () => {
    await withVault(async (vault) => {
      writeRecipeNote(vault, "Recipes/fb.md", {
        id: "fb",
        tags: ["*neon", "old-tag"],
        nodes: [
          { name: "fb", type: "feedbackTOP" },
          { name: "g", type: "glslTOP" },
        ],
      });
      const result = await autoTagLibraryAssetImpl(ctxWith(vault), {
        target: "vault_note",
        note_path: "Recipes/fb.md",
        comp_path: "/project1",
        category_hint: "auto",
        write: true,
        overwrite_existing_tags: true,
        max_tags: 8,
        min_confidence: 0.35,
        include_difficulty: true,
        include_description: true,
      });
      expect(result.isError).toBeFalsy();
      const after = vault.readNote("Recipes/fb.md");
      const tags = after.data.tags as string[];
      expect(tags).toContain("*neon");
      expect(tags).not.toContain("old-tag");
    });
  });

  it("td_comp path: reads the bridge capture and returns a suggestion (no write without note_path)", async () => {
    await withVault(async (vault) => {
      mockCapture({
        comp: "/project1",
        nodes: [
          { name: "fb", type: "feedbackTOP" },
          { name: "g", type: "glslTOP" },
          { name: "n", type: "noiseTOP" },
        ],
        connections: [{ from: "n", to: "g", from_output: 0, to_input: 0 }],
        python_code: {},
        warnings: [],
      });
      const result = await autoTagLibraryAssetImpl(ctxWith(vault), {
        target: "td_comp",
        comp_path: "/project1",
        category_hint: "auto",
        write: false,
        overwrite_existing_tags: false,
        max_tags: 8,
        min_confidence: 0.35,
        include_difficulty: true,
        include_description: true,
      });
      expect(result.isError).toBeFalsy();
      const data = jsonOf<{
        suggested_tags: string[];
        node_count: number;
        written: boolean;
        note_path: string | null;
      }>(result);
      expect(data.node_count).toBe(3);
      expect(data.note_path).toBeNull();
      expect(data.written).toBe(false);
      expect(data.suggested_tags).toEqual(expect.arrayContaining(["feedback", "glsl"]));
    });
  });

  it("vault_note path errors when note_path is missing", async () => {
    await withVault(async (vault) => {
      const result = await autoTagLibraryAssetImpl(ctxWith(vault), {
        target: "vault_note",
        comp_path: "/project1",
        category_hint: "auto",
        write: false,
        overwrite_existing_tags: false,
        max_tags: 8,
        min_confidence: 0.35,
        include_difficulty: true,
        include_description: true,
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("note_path is required");
    });
  });
});
