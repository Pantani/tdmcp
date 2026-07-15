import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  marketplaceIndexSeedImpl,
  marketplaceIndexSeedSchema,
  registerMarketplaceIndexSeed,
} from "../../src/tools/library/marketplaceIndexSeed.js";
import type { ToolContext } from "../../src/tools/types.js";

const ctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
} as unknown as ToolContext;

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tdmcp-marketplace-seed-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("marketplace_index_seed", () => {
  it("schema defaults include built-in starters and protect existing files", () => {
    const parsed = marketplaceIndexSeedSchema.parse({ out_file: join(tmpDir, "index.seed.json") });
    expect(parsed.name).toBe("tdmcp-local-marketplace");
    expect(parsed.include_builtin_starters).toBe(true);
    expect(parsed.overwrite).toBe(false);
  });

  it("writes a starter marketplace seed with built-ins and custom entries", async () => {
    const outFile = join(tmpDir, "marketplace.seed.json");
    const result = await marketplaceIndexSeedImpl(ctx, {
      out_file: outFile,
      name: "demo-market",
      include_builtin_starters: true,
      overwrite: false,
      entries: [
        {
          id: "my-pack",
          name: "My Pack",
          version: "1.2.3",
          kind: "component-pack",
          description: "Local custom component pack.",
          tags: ["local"],
          source_path: "packs/my-pack.pack",
        },
      ],
    });

    expect(result.isError).toBeFalsy();
    expect(existsSync(outFile)).toBe(true);
    const saved = JSON.parse(readFileSync(outFile, "utf8")) as {
      kind: string;
      name: string;
      entries: Array<{ id: string }>;
    };
    expect(saved.kind).toBe("tdmcp-marketplace-index-seed");
    expect(saved.name).toBe("demo-market");
    expect(saved.entries).toHaveLength(6);
    expect(saved.entries.map((entry) => entry.id)).toContain("my-pack");
    expect((result.structuredContent as { builtin_count: number }).builtin_count).toBe(5);
  });

  it("refuses to overwrite an existing seed unless overwrite is true", async () => {
    const outFile = join(tmpDir, "marketplace.seed.json");
    writeFileSync(outFile, "already here", "utf8");
    const result = await marketplaceIndexSeedImpl(ctx, {
      out_file: outFile,
      name: "demo",
      include_builtin_starters: true,
      overwrite: false,
      entries: [],
    });
    expect(result.isError).toBe(true);
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("overwrite:true");
  });

  it("rejects duplicate ids across starter and custom entries", async () => {
    const result = await marketplaceIndexSeedImpl(ctx, {
      out_file: join(tmpDir, "dupe.json"),
      name: "demo",
      include_builtin_starters: true,
      overwrite: false,
      entries: [
        {
          id: "vj-starter-recipes",
          name: "Duplicate",
          version: "0.1.0",
          kind: "recipe-pack",
          description: "Duplicate id.",
          tags: [],
        },
      ],
    });
    expect(result.isError).toBe(true);
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("Duplicate marketplace entry id");
  });

  it("is registered as a guarded local-file writer", () => {
    const calls: Array<{ name: string; options: { annotations?: Record<string, boolean> } }> = [];
    const fakeServer = {
      registerTool(name: string, options: { annotations?: Record<string, boolean> }) {
        calls.push({ name, options });
      },
    };
    registerMarketplaceIndexSeed(fakeServer as never, ctx);
    expect(calls[0]?.name).toBe("marketplace_index_seed");
    expect(calls[0]?.options.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    });
  });
});
