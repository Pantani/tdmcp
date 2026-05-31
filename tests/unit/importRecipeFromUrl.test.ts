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
function stubDownload(content: string | Buffer, opts: { calls?: { count: number } } = {}) {
  return vi
    .spyOn(downloaders, "download")
    .mockImplementation(async (_url: string, dest: string, maxBytes: number) => {
      if (opts.calls) {
        opts.calls.count += 1;
      }
      const bytes = Buffer.isBuffer(content)
        ? content.byteLength
        : Buffer.byteLength(content, "utf8");
      if (bytes > maxBytes) {
        throw new Error(`Download exceeds size limit (> ${maxBytes} bytes)`);
      }
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, content);
    });
}

let dir: string;

type ImportRecipeFromUrlModule = typeof import("../../src/tools/library/importRecipeFromUrl.js") & {
  fileOps?: {
    cleanup: (path: string) => void;
  };
};

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

  it("schema trims out_dir and rejects blank output directories", () => {
    const parsed = importRecipeFromUrlSchema.parse({
      url: "https://raw.githubusercontent.com/a/b/main/r.json",
      out_dir: "  /tmp/x  ",
    });
    expect(parsed.out_dir).toBe("/tmp/x");
    expect(() =>
      importRecipeFromUrlSchema.parse({
        url: "https://raw.githubusercontent.com/a/b/main/r.json",
        out_dir: "   ",
      }),
    ).toThrow();
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

  it("swallows temporary cleanup failures after a successful download", async () => {
    const recipe = {
      id: "cleanup-failure",
      name: "Cleanup Failure",
      nodes: [{ name: "n1", type: "noiseTOP" }],
    };
    stubDownload(JSON.stringify(recipe));
    const module = (await import(
      "../../src/tools/library/importRecipeFromUrl.js"
    )) as ImportRecipeFromUrlModule;
    const { fileOps } = module;
    expect(fileOps).toBeDefined();
    if (!fileOps) throw new Error("fileOps export missing");
    const cleanupSpy = vi.spyOn(fileOps, "cleanup").mockImplementation(() => {
      throw new Error("cleanup locked");
    });

    const res = await importRecipeFromUrlImpl(makeCtx(), {
      url: "https://raw.githubusercontent.com/acme/repo/main/cleanup-failure.json",
      out_dir: join(dir, "out"),
      overwrite: false,
      max_bytes: 1048576,
    });

    expect(cleanupSpy).toHaveBeenCalled();
    expect(res.isError).toBeFalsy();
    const parsed = resultJson(res);
    expect(parsed.count).toBe(1);
    expect(parsed.written[0]).toContain("cleanup-failure.json");
  });

  it("test downloader can write byte buffers without UTF-8 transcoding", async () => {
    const recipe = {
      id: "buffered-recipe",
      name: "Buffered Recipe",
      nodes: [{ name: "n1", type: "noiseTOP" }],
    };
    const spy = stubDownload(Buffer.from(JSON.stringify(recipe), "utf8"));

    const res = await importRecipeFromUrlImpl(makeCtx(), {
      url: "https://raw.githubusercontent.com/acme/repo/main/buffered.json",
      out_dir: join(dir, "out"),
      overwrite: false,
      max_bytes: 1048576,
    });

    expect(res.isError).toBeFalsy();
    expect(resultJson(res).count).toBe(1);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("writes every recipe in a recipe-bundle JSON document", async () => {
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

  it("uses a non-hidden fallback filename when recipe id is empty", async () => {
    const recipe = {
      id: "",
      name: "Unnamed Recipe",
      nodes: [{ name: "n1", type: "noiseTOP" }],
    };
    stubDownload(JSON.stringify(recipe));

    const res = await importRecipeFromUrlImpl(makeCtx(), {
      url: "https://raw.githubusercontent.com/acme/repo/main/unnamed.json",
      out_dir: join(dir, "out"),
      overwrite: false,
      max_bytes: 1048576,
    });

    expect(res.isError).toBeFalsy();
    const parsed = resultJson(res);
    expect(parsed.written[0]).toContain("recipe.json");
    expect(parsed.written[0]).not.toContain(`${join(dir, "out")}/.json`);
  });

  it("rejects duplicate fallback targets before writing", async () => {
    const bundle = {
      recipes: [
        { id: "", name: "First", nodes: [{ name: "n1", type: "noiseTOP" }] },
        { id: "", name: "Second", nodes: [{ name: "n2", type: "rampTOP" }] },
      ],
    };
    const outDir = join(dir, "out");
    stubDownload(JSON.stringify(bundle));

    const res = await importRecipeFromUrlImpl(makeCtx(), {
      url: "https://raw.githubusercontent.com/acme/repo/main/unnamed-bundle.json",
      out_dir: outDir,
      overwrite: false,
      max_bytes: 1048576,
    });

    expect(res.isError).toBe(true);
    expect(resultText(res)).toContain("Duplicate recipe target path");
    expect(existsSync(outDir)).toBe(false);
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

  it("returns isError when writing an imported recipe fails", async () => {
    const recipe = {
      id: "write-fails",
      name: "Write Fails",
      nodes: [{ name: "n1", type: "noiseTOP" }],
    };
    const outDir = join(dir, "not-a-dir");
    writeFileSync(outDir, "occupied", "utf8");
    stubDownload(JSON.stringify(recipe));

    let res: Awaited<ReturnType<typeof importRecipeFromUrlImpl>> | undefined;
    await expect(
      (async () => {
        res = await importRecipeFromUrlImpl(makeCtx(), {
          url: "https://raw.githubusercontent.com/acme/repo/main/write-fails.json",
          out_dir: outDir,
          overwrite: false,
          max_bytes: 1048576,
        });
      })(),
    ).resolves.toBeUndefined();

    expect(res?.isError).toBe(true);
    expect(resultText(res as CallToolResult)).toContain("Failed to write recipe");
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
