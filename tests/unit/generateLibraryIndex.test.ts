import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ToolContext } from "../../src/tools/types.js";
import {
  generateLibraryIndexImpl,
  generateLibraryIndexSchema,
} from "../../src/tools/vault/generateLibraryIndex.js";
import { silentLogger } from "../../src/utils/logger.js";
import { Vault } from "../../src/vault/index.js";
import { makeTdServer } from "../helpers/tdMock.js";

// The tool never touches the bridge, but block any stray request to prove it.
const server = makeTdServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function ctxNoVault(): ToolContext {
  return { logger: silentLogger } as unknown as ToolContext;
}

function ctxWith(vault: Vault): ToolContext {
  return { logger: silentLogger, vault } as unknown as ToolContext;
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

interface IndexData {
  index_path: string;
  total: number;
  counts: Record<string, number>;
  with_thumbnails: number;
  without_thumbnails: number;
  warnings: string[];
}

function dataOf(result: CallToolResult): IndexData {
  return result.structuredContent as unknown as IndexData;
}

/** A 1×1 PNG so a sibling thumbnail exists on disk. */
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function withVault(fn: (vault: Vault) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "tdmcp-generateLibraryIndex-"));
  return Promise.resolve(fn(new Vault(dir))).finally(() =>
    rmSync(dir, { recursive: true, force: true }),
  );
}

const FULL_ARGS = {
  kinds: ["all"] as const,
  output: "Library Index.md",
  include_thumbnails: true,
  columns: 2,
  overwrite: true,
};

describe("generateLibraryIndexSchema", () => {
  it("applies defaults", () => {
    const parsed = generateLibraryIndexSchema.parse({});
    expect(parsed.kinds).toEqual(["all"]);
    expect(parsed.output).toBe("Library Index.md");
    expect(parsed.include_thumbnails).toBe(true);
    expect(parsed.columns).toBe(3);
    expect(parsed.overwrite).toBe(true);
  });

  it("coerces a string columns value", () => {
    expect(generateLibraryIndexSchema.parse({ columns: "4" }).columns).toBe(4);
  });
});

describe("generateLibraryIndexImpl", () => {
  // ── no vault ───────────────────────────────────────────────────────────────
  it("returns isError when no vault is configured — never throws", async () => {
    const result = await generateLibraryIndexImpl(ctxNoVault(), {
      ...FULL_ARGS,
      kinds: ["all"],
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("TDMCP_VAULT_PATH");
  });

  // ── empty vault ────────────────────────────────────────────────────────────
  it("writes a valid 'no assets' note on an empty vault (total:0, not an error)", async () => {
    await withVault(async (vault) => {
      const result = await generateLibraryIndexImpl(ctxWith(vault), {
        ...FULL_ARGS,
        kinds: ["all"],
      });
      expect(result.isError).toBeFalsy();
      const data = dataOf(result);
      expect(data.total).toBe(0);
      expect(vault.exists("Library Index.md")).toBe(true);
      const note = vault.read("Library Index.md");
      expect(note).toContain("No library assets found");
      expect(note).toContain("type: library-index");
    });
  });

  // ── populated vault ─────────────────────────────────────────────────────────
  it("renders contact-sheet rows from a populated vault", async () => {
    await withVault(async (vault) => {
      vault.writeNote(
        "Recipes/neonGlow.md",
        { id: "neonGlow", name: "Neon Glow", tags: ["glow"] },
        "A neon glow recipe.",
      );
      vault.writeBinary("Recipes/neonGlow.png", Buffer.from(PNG_B64, "base64"));
      vault.writeNote(
        "Components/BeatMask.md",
        { type: "component", tox: "Components/BeatMask.tox", tags: ["mask", "audio"] },
        "Beat mask.",
      );

      const result = await generateLibraryIndexImpl(ctxWith(vault), {
        ...FULL_ARGS,
        kinds: ["all"],
      });
      expect(result.isError).toBeFalsy();
      const data = dataOf(result);
      expect(data.counts.recipes).toBe(1);
      expect(data.counts.components).toBe(1);
      expect(data.total).toBe(2);
      expect(data.with_thumbnails).toBe(1);
      expect(data.without_thumbnails).toBe(1);

      const note = vault.read("Library Index.md");
      expect(note).toContain("## Recipes");
      expect(note).toContain("![[neonGlow.png]]");
      expect(note).toContain("`apply_recipe id=neonGlow`");
      expect(note).toContain("## Components");
      expect(note).toContain(
        "manage_component action=load file_path=<vault>/Components/BeatMask.tox",
      );
      // BeatMask has no sibling PNG → placeholder.
      expect(note).toContain("_(no preview)_");
    });
  });

  it("derives the recipe load id from the stem when frontmatter id is absent", async () => {
    await withVault(async (vault) => {
      vault.writeNote("Recipes/plasma.md", { name: "Plasma", tags: [] }, "Plasma.");
      const result = await generateLibraryIndexImpl(ctxWith(vault), {
        ...FULL_ARGS,
        kinds: ["recipes"],
      });
      expect(result.isError).toBeFalsy();
      expect(vault.read("Library Index.md")).toContain("`apply_recipe id=plasma`");
    });
  });

  // ── thumbnails off ───────────────────────────────────────────────────────────
  it("renders text-only rows (no embeds) when include_thumbnails is false", async () => {
    await withVault(async (vault) => {
      vault.writeNote("Recipes/neonGlow.md", { id: "neonGlow", tags: [] }, "Glow.");
      vault.writeBinary("Recipes/neonGlow.png", Buffer.from(PNG_B64, "base64"));

      const result = await generateLibraryIndexImpl(ctxWith(vault), {
        ...FULL_ARGS,
        kinds: ["recipes"],
        include_thumbnails: false,
      });
      expect(result.isError).toBeFalsy();
      const note = vault.read("Library Index.md");
      expect(note).not.toContain("![[");
      // The card is still present (title/snippet), just text-only.
      expect(note).toContain("`apply_recipe id=neonGlow`");
      expect(dataOf(result).with_thumbnails).toBe(0);
    });
  });

  // ── missing PNG ───────────────────────────────────────────────────────────────
  it("shows _(no preview)_ and counts a recipe without a sibling PNG", async () => {
    await withVault(async (vault) => {
      vault.writeNote("Recipes/noPng.md", { id: "noPng", tags: [] }, "No png.");
      const result = await generateLibraryIndexImpl(ctxWith(vault), {
        ...FULL_ARGS,
        kinds: ["recipes"],
      });
      const note = vault.read("Library Index.md");
      expect(note).toContain("_(no preview)_");
      expect(note).not.toContain("![[");
      expect(dataOf(result).without_thumbnails).toBe(1);
      expect(dataOf(result).with_thumbnails).toBe(0);
    });
  });

  // ── query filter ──────────────────────────────────────────────────────────────
  it("filters by query on title/tags", async () => {
    await withVault(async (vault) => {
      vault.writeNote("Recipes/neonGlow.md", { id: "neonGlow", name: "Neon Glow", tags: [] }, "x");
      vault.writeNote("Recipes/plasma.md", { id: "plasma", name: "Plasma", tags: [] }, "y");

      const result = await generateLibraryIndexImpl(ctxWith(vault), {
        ...FULL_ARGS,
        kinds: ["recipes"],
        query: "neon",
      });
      const data = dataOf(result);
      expect(data.counts.recipes).toBe(1);
      expect(data.total).toBe(1);
      const note = vault.read("Library Index.md");
      expect(note).toContain("Neon Glow");
      expect(note).not.toContain("Plasma");
    });
  });

  // ── overwrite guard ───────────────────────────────────────────────────────────
  it("refuses to overwrite an existing index when overwrite:false", async () => {
    await withVault(async (vault) => {
      vault.write("Library Index.md", "# pre-existing");
      const result = await generateLibraryIndexImpl(ctxWith(vault), {
        ...FULL_ARGS,
        kinds: ["all"],
        overwrite: false,
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("already exists");
      // The original file is untouched.
      expect(vault.read("Library Index.md")).toBe("# pre-existing");
    });
  });

  it("overwrites silently with the default overwrite:true", async () => {
    await withVault(async (vault) => {
      vault.write("Library Index.md", "# pre-existing");
      const result = await generateLibraryIndexImpl(ctxWith(vault), {
        ...FULL_ARGS,
        kinds: ["all"],
      });
      expect(result.isError).toBeFalsy();
      expect(vault.read("Library Index.md")).not.toBe("# pre-existing");
      expect(vault.read("Library Index.md")).toContain("type: library-index");
    });
  });

  // ── unreadable note ───────────────────────────────────────────────────────────
  it("pushes a warning and continues when a note has malformed frontmatter", async () => {
    await withVault(async (vault) => {
      // Malformed YAML frontmatter — gray-matter throws, readNoteSafe degrades to an error.
      vault.write("Recipes/bad.md", "---\n: : not: valid: yaml\n  - [\n---\nbody");
      vault.writeNote("Recipes/good.md", { id: "good", tags: [] }, "ok");

      let threw = false;
      let result: Awaited<ReturnType<typeof generateLibraryIndexImpl>> | undefined;
      try {
        result = await generateLibraryIndexImpl(ctxWith(vault), {
          ...FULL_ARGS,
          kinds: ["recipes"],
        });
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
      expect(result?.isError).toBeFalsy();
      const data = dataOf(result as CallToolResult);
      expect(data.warnings.some((w) => w.includes("bad.md"))).toBe(true);
      // The good recipe still made it into the index.
      expect(data.counts.recipes).toBe(1);
      expect(vault.read("Library Index.md")).toContain("`apply_recipe id=good`");
    });
  });
});
