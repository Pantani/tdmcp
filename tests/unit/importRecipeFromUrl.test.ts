import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  downloaders,
  importRecipeFromUrlImpl,
  importRecipeFromUrlSchema,
} from "../../src/tools/library/importRecipeFromUrl.js";
import type { ToolContext } from "../../src/tools/types.js";

// The tool only touches the network + filesystem; ctx is unused, so an empty
// stub suffices (mirrors the pure importRecipeBundleImpl tests).
function makeCtx(): ToolContext {
  return {} as ToolContext;
}

function resultText(res: CallToolResult): string {
  const block = res.content[0];
  return block && block.type === "text" ? block.text : "";
}

/** Pull the JSON fence out of a jsonResult text block. */
function resultJson(res: CallToolResult): {
  url: string;
  written: string[];
  skipped: string[];
  count: number;
} {
  const text = resultText(res);
  const fence = text.split("```json")[1]?.split("```")[0] ?? "{}";
  return JSON.parse(fence);
}

// Override the documented download indirection so the test never touches the
// network. The override writes the supplied fixture to the temp dest file,
// honoring the byte cap exactly like the real hardened downloader would.
function stubDownload(content: string, opts: { calls?: { count: number } } = {}) {
  return vi
    .spyOn(downloaders, "download")
    .mockImplementation(async (_url: string, dest: string, maxBytes: number) => {
      if (opts.calls) {
        opts.calls.count += 1;
      }
      const bytes = Buffer.byteLength(content, "utf8");
      if (bytes > maxBytes) {
        throw new Error(`Download exceeds size limit (> ${maxBytes} bytes)`);
      }
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, content, "utf8");
    });
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tdmcp-recipe-url-test-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("importRecipeFromUrlImpl", () => {
  it("schema defaults: max_bytes 1 MiB, overwrite false", () => {
    const parsed = importRecipeFromUrlSchema.parse({
      url: "https://raw.githubusercontent.com/a/b/main/r.json",
      out_dir: "/tmp/x",
    });
    expect(parsed.max_bytes).toBe(1048576);
    expect(parsed.overwrite).toBe(false);
  });

  it("writes a single recipe fetched from a URL", async () => {
    const recipe = {
      id: "my-recipe",
      name: "My Recipe",
      nodes: [{ name: "n1", type: "noiseTOP" }],
    };
    const spy = stubDownload(JSON.stringify(recipe));

    const res = await importRecipeFromUrlImpl(makeCtx(), {
      url: "https://raw.githubusercontent.com/acme/repo/main/recipe.json",
      out_dir: join(dir, "out"),
      overwrite: false,
      max_bytes: 1048576,
    });

    expect(res.isError).toBeFalsy();
    const parsed = resultJson(res);
    expect(parsed.count).toBe(1);
    expect(parsed.written).toHaveLength(1);
    expect(parsed.skipped).toHaveLength(0);
    expect(spy).toHaveBeenCalledTimes(1);

    const firstWritten = parsed.written[0] as string;
    expect(firstWritten).toContain("my-recipe.json");
    const onDisk = JSON.parse(readFileSync(firstWritten, "utf8"));
    expect(onDisk.name).toBe("My Recipe");
  });

  it("writes every recipe in a bundle", async () => {
    const bundle = {
      recipes: [
        { id: "alpha", name: "Alpha", nodes: [{ name: "n1", type: "noiseTOP" }] },
        { id: "beta", name: "Beta", nodes: [{ name: "r1", type: "rampTOP" }] },
      ],
    };
    stubDownload(JSON.stringify(bundle));

    const res = await importRecipeFromUrlImpl(makeCtx(), {
      url: "https://raw.githubusercontent.com/acme/repo/main/bundle.json",
      out_dir: join(dir, "out"),
      overwrite: false,
      max_bytes: 1048576,
    });

    expect(res.isError).toBeFalsy();
    const parsed = resultJson(res);
    expect(parsed.count).toBe(2);
    expect(parsed.written).toHaveLength(2);
  });

  it("returns isError on invalid JSON (never throws)", async () => {
    stubDownload("{ not json ::");

    const res = await importRecipeFromUrlImpl(makeCtx(), {
      url: "https://raw.githubusercontent.com/acme/repo/main/bad.json",
      out_dir: join(dir, "out"),
      overwrite: false,
      max_bytes: 1048576,
    });

    expect(res.isError).toBe(true);
    expect(resultText(res)).toContain("not valid JSON");
  });

  it("rejects a non-HTTPS URL without any network call", async () => {
    const calls = { count: 0 };
    stubDownload("{}", { calls });

    const res = await importRecipeFromUrlImpl(makeCtx(), {
      url: "http://example.com/recipe.json",
      out_dir: join(dir, "out"),
      overwrite: false,
      max_bytes: 1048576,
    });

    expect(res.isError).toBe(true);
    expect(resultText(res)).toContain("non-HTTPS");
    expect(calls.count).toBe(0);
  });

  it("returns isError when a target already exists and overwrite is false", async () => {
    const recipe = {
      id: "my-recipe",
      name: "My Recipe",
      nodes: [{ name: "n1", type: "noiseTOP" }],
    };
    const outDir = join(dir, "out");
    // Pre-create the exact target the import would write.
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "my-recipe.json"), "{}", "utf8");
    stubDownload(JSON.stringify(recipe));

    const res = await importRecipeFromUrlImpl(makeCtx(), {
      url: "https://raw.githubusercontent.com/acme/repo/main/recipe.json",
      out_dir: outDir,
      overwrite: false,
      max_bytes: 1048576,
    });

    expect(res.isError).toBe(true);
    expect(resultText(res)).toContain("already exists");
  });

  it("overwrite:true replaces an existing target", async () => {
    const recipe = { id: "my-recipe", name: "New Name", nodes: [{ name: "n1", type: "noiseTOP" }] };
    const outDir = join(dir, "out");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "my-recipe.json"), JSON.stringify({ name: "Old" }), "utf8");
    stubDownload(JSON.stringify(recipe));

    const res = await importRecipeFromUrlImpl(makeCtx(), {
      url: "https://raw.githubusercontent.com/acme/repo/main/recipe.json",
      out_dir: outDir,
      overwrite: true,
      max_bytes: 1048576,
    });

    expect(res.isError).toBeFalsy();
    const onDisk = JSON.parse(readFileSync(join(outDir, "my-recipe.json"), "utf8"));
    expect(onDisk.name).toBe("New Name");
  });

  it("returns isError when the download exceeds the byte cap (never throws)", async () => {
    const outDir = join(dir, "out");
    stubDownload(
      JSON.stringify({ id: "big", name: "Big", nodes: [{ name: "n", type: "noiseTOP" }] }),
    );

    const res = await importRecipeFromUrlImpl(makeCtx(), {
      url: "https://raw.githubusercontent.com/acme/repo/main/big.json",
      out_dir: outDir,
      overwrite: false,
      max_bytes: 4,
    });

    expect(res.isError).toBe(true);
    expect(resultText(res)).toContain("Failed to download");
    // Nothing was written because the download failed before any file write.
    expect(existsSync(outDir)).toBe(false);
  });
});
