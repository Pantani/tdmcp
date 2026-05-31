import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import type { ToolContext } from "../../src/tools/types.js";
import {
  recallSimilarWorkImpl,
  recallSimilarWorkOutputSchema,
} from "../../src/tools/vault/recallSimilarWork.js";
import { silentLogger } from "../../src/utils/logger.js";
import { Vault } from "../../src/vault/index.js";
import { makeTdServer } from "../helpers/tdMock.js";

const server = makeTdServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function ctxNoVault(): ToolContext {
  return {
    client: new TouchDesignerClient({ baseUrl: "http://127.0.0.1:1", timeoutMs: 500 }),
    knowledge: new KnowledgeBase(),
    recipes: new RecipeLibrary(),
    logger: silentLogger,
  };
}

function withVault(fn: (vault: Vault, ctx: ToolContext) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "tdmcp-recall-"));
  const vault = new Vault(dir);
  const ctx: ToolContext = {
    client: new TouchDesignerClient({ baseUrl: "http://127.0.0.1:1", timeoutMs: 500 }),
    knowledge: new KnowledgeBase(),
    recipes: new RecipeLibrary({ vault }),
    logger: silentLogger,
    vault,
  };
  return Promise.resolve(fn(vault, ctx)).finally(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}

function defaults<T extends Record<string, unknown>>(overrides: T) {
  return {
    tags: [] as string[],
    ops: [] as string[],
    limit: 5,
    min_score: 0.1,
    include_body_snippet: true,
    ...overrides,
  };
}

type Result = Awaited<ReturnType<typeof recallSimilarWorkImpl>>;
function sc(result: Result) {
  return (result as { structuredContent: unknown }).structuredContent as {
    vault_path: string;
    query: string;
    hits: Array<{
      path: string;
      title: string;
      intent?: string;
      tags: string[];
      ops: string[];
      recipe?: string;
      prompt?: string;
      preview?: string;
      score: number;
      matched: { query_terms: string[]; tag_overlap: string[]; op_overlap: string[] };
      snippet?: string;
    }>;
    scanned: number;
    warnings: string[];
  };
}

function seedFeedbackCubes(vault: Vault) {
  vault.writeNote(
    "Memory/2026-05-30-cubes.md",
    {
      title: "Audio-reactive cubes for techno set",
      created: "2026-05-30T12:00:00Z",
      intent: "punchy beat-reactive 3D with chromatic feedback",
      tags: ["audio-reactive", "3d", "feedback", "techno"],
      ops: ["audioAnalysisCHOP", "boxSOP", "geometryCOMP", "feedbackTOP"],
    },
    "kick-band gain 1.4 worked; rgb split on feedback @ 0.06 made the cubes pop on every beat",
  );
}

function seedBassline(vault: Vault) {
  vault.writeNote(
    "Memory/2026-04-12-bass.md",
    {
      title: "Bassline pulse rig",
      created: "2026-04-12T00:00:00Z",
      intent: "low-end reactive pulse",
      tags: ["audio-reactive"],
      ops: ["audioAnalysisCHOP"],
    },
    "envelope follower into transform tx for a slow pulse.",
  );
}

function seedTextOverlay(vault: Vault) {
  vault.writeNote(
    "Memory/2026-03-01-text.md",
    {
      title: "Lyric text overlay",
      created: "2026-03-01T00:00:00Z",
      intent: "static title card",
      tags: ["text"],
      ops: ["textTOP"],
    },
    "white serif on black, centered",
  );
}

describe("recallSimilarWorkImpl", () => {
  it("returns isError when no vault is configured", async () => {
    const r = await recallSimilarWorkImpl(ctxNoVault(), defaults({ query: "anything" }));
    expect(r.isError).toBe(true);
  });

  it("returns empty hits when Memory/ is missing or empty", async () => {
    await withVault(async (_v, ctx) => {
      const r = await recallSimilarWorkImpl(ctx, defaults({ query: "feedback cubes" }));
      const s = sc(r);
      expect(s.hits).toEqual([]);
      expect(s.scanned).toBe(0);
      expect(s.warnings).toEqual([]);
    });
  });

  it("ranks the feedback-cubes note above the unrelated text overlay", async () => {
    await withVault(async (vault, ctx) => {
      seedFeedbackCubes(vault);
      seedBassline(vault);
      seedTextOverlay(vault);
      const r = await recallSimilarWorkImpl(
        ctx,
        defaults({ query: "beat reactive feedback cubes" }),
      );
      const s = sc(r);
      expect(s.hits.length).toBeGreaterThan(0);
      expect(s.hits[0]?.path).toBe("Memory/2026-05-30-cubes.md");
      // Text-overlay note should not appear (no token overlap with the query).
      expect(s.hits.find((h) => h.path === "Memory/2026-03-01-text.md")).toBeUndefined();
      expect(s.hits[0]?.matched.query_terms).toEqual(expect.arrayContaining(["feedback", "cubes"]));
    });
  });

  it("tag boost reorders results toward tag-matching notes", async () => {
    await withVault(async (vault, ctx) => {
      seedFeedbackCubes(vault);
      // Second note has higher text overlap but no techno tag.
      vault.writeNote(
        "Memory/other.md",
        {
          title: "feedback feedback feedback rig",
          created: "2026-05-29T00:00:00Z",
          intent: "feedback feedback feedback",
          tags: ["abstract"],
          ops: [],
        },
        "feedback feedback feedback",
      );
      const r = await recallSimilarWorkImpl(ctx, defaults({ query: "feedback", tags: ["techno"] }));
      const s = sc(r);
      expect(s.hits[0]?.path).toBe("Memory/2026-05-30-cubes.md");
      expect(s.hits[0]?.matched.tag_overlap).toEqual(["techno"]);
    });
  });

  it("op boost surfaces notes whose ops overlap the query", async () => {
    await withVault(async (vault, ctx) => {
      seedFeedbackCubes(vault);
      seedBassline(vault);
      const r = await recallSimilarWorkImpl(
        ctx,
        defaults({ query: "reactive", ops: ["feedbackTOP"] }),
      );
      const s = sc(r);
      expect(s.hits[0]?.path).toBe("Memory/2026-05-30-cubes.md");
      expect(s.hits[0]?.matched.op_overlap).toEqual(["feedbackTOP"]);
    });
  });

  it("respects min_score and limit", async () => {
    await withVault(async (vault, ctx) => {
      seedFeedbackCubes(vault);
      seedBassline(vault);
      seedTextOverlay(vault);
      const high = await recallSimilarWorkImpl(
        ctx,
        defaults({ query: "feedback cubes", min_score: 0.9 }),
      );
      expect(sc(high).hits).toEqual([]);
      const one = await recallSimilarWorkImpl(ctx, defaults({ query: "feedback cubes", limit: 1 }));
      expect(sc(one).hits.length).toBe(1);
    });
  });

  it("skips notes with malformed frontmatter and reports a warning", async () => {
    await withVault(async (vault, ctx) => {
      seedFeedbackCubes(vault);
      // Write a deliberately broken YAML frontmatter file directly.
      const broken = "---\ntitle: [unterminated\n---\nbody\n";
      writeFileSync(join(vault.root, "Memory", "broken.md"), broken);
      const r = await recallSimilarWorkImpl(ctx, defaults({ query: "feedback cubes" }));
      const s = sc(r);
      expect(s.warnings.length).toBe(1);
      expect(s.warnings[0]).toContain("Memory/broken.md");
      expect(s.hits[0]?.path).toBe("Memory/2026-05-30-cubes.md");
    });
  });

  it("omits snippet when include_body_snippet is false", async () => {
    await withVault(async (vault, ctx) => {
      seedFeedbackCubes(vault);
      const r = await recallSimilarWorkImpl(
        ctx,
        defaults({ query: "feedback cubes", include_body_snippet: false }),
      );
      const s = sc(r);
      expect(s.hits[0]).toBeDefined();
      expect(s.hits[0]?.snippet).toBeUndefined();
    });
  });

  it("validates against the output schema", async () => {
    await withVault(async (vault, ctx) => {
      seedFeedbackCubes(vault);
      seedBassline(vault);
      const r = await recallSimilarWorkImpl(ctx, defaults({ query: "feedback" }));
      const s = sc(r);
      expect(() => recallSimilarWorkOutputSchema.parse(s)).not.toThrow();
    });
  });
});
