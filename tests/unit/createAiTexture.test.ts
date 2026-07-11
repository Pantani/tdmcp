import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildToolContext } from "../../src/server/context.js";
import type { ImageProvider } from "../../src/services/imageGen/types.js";
import {
  type CreateAiTextureArgs,
  createAiTextureImpl,
  createAiTextureSchema,
} from "../../src/tools/layer2/createAiTexture.js";
import { loadConfig } from "../../src/utils/config.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

const server = makeTdServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// A real 1×1 PNG so the cache write produces a genuine image file on disk.
const PNG_BYTES = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  ),
);

const tmpDirs: string[] = [];
async function freshCacheDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tdmcp-ai-texture-"));
  tmpDirs.push(dir);
  return dir;
}
afterAll(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

/** A no-network image provider that returns real PNG bytes. */
function fakeProvider(): ImageProvider {
  return {
    id: "fal",
    defaultModel: "fal-ai/flux/schnell",
    async generate(req) {
      return {
        bytes: PNG_BYTES,
        mimeType: "image/png",
        provider: "fal",
        model: req.model ?? "fal-ai/flux/schnell",
        seed: req.seed,
      };
    },
  };
}

/** A provider that records the seed of every request into `seeds`. */
function spyProvider(seeds: Array<number | undefined>): ImageProvider {
  return {
    id: "fal",
    defaultModel: "fal-ai/flux/schnell",
    async generate(req) {
      seeds.push(req.seed);
      return {
        bytes: PNG_BYTES,
        mimeType: "image/png",
        provider: "fal",
        model: req.model ?? "fal-ai/flux/schnell",
        seed: req.seed,
      };
    },
  };
}

/** A provider that throws on its Nth call (1-based) and returns bytes otherwise. */
function throwOnNthProvider(n: number): ImageProvider {
  let calls = 0;
  return {
    id: "fal",
    defaultModel: "fal-ai/flux/schnell",
    async generate(req) {
      calls += 1;
      if (calls === n) throw new Error("provider exploded");
      return {
        bytes: PNG_BYTES,
        mimeType: "image/png",
        provider: "fal",
        model: req.model ?? "fal-ai/flux/schnell",
        seed: req.seed,
      };
    },
  };
}

interface ConnectBody {
  source_path: string;
  target_path: string;
  source_output: number;
  target_input: number;
}

/** Captures /api/connect bodies so pack wiring (source → grid input i) can be asserted. */
function captureConnectBodies(): ConnectBody[] {
  const bodies: ConnectBody[] = [];
  server.use(
    http.post(`${TD_BASE}/api/connect`, async ({ request }) => {
      const body = (await request.json()) as ConnectBody;
      bodies.push(body);
      return HttpResponse.json({
        ok: true,
        data: {
          source_path: body.source_path,
          target_path: body.target_path,
          connected: true,
          actual_input: body.target_input,
        },
      });
    }),
  );
  return bodies;
}

function makeArgs(over: Partial<CreateAiTextureArgs> = {}): CreateAiTextureArgs {
  return {
    prompt: "a neon jellyfish drifting through fog",
    width: 1024,
    height: 1024,
    play: true,
    name: "ai_texture",
    parent_path: "/project1",
    num_images: 1,
    ...over,
  };
}

interface CreatedNodeBody {
  parent_path: string;
  type: string;
  name?: string;
  parameters?: Record<string, unknown>;
}

function captureCreateBodies(): CreatedNodeBody[] {
  const bodies: CreatedNodeBody[] = [];
  server.use(
    http.post(`${TD_BASE}/api/nodes`, async ({ request }) => {
      const body = (await request.json()) as CreatedNodeBody;
      bodies.push(body);
      const name = body.name ?? `${body.type.replace(/[^a-zA-Z0-9]/g, "").toLowerCase()}1`;
      return HttpResponse.json({
        ok: true,
        data: { path: `${body.parent_path}/${name}`, type: body.type, name },
      });
    }),
  );
  return bodies;
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

function jsonBlock(text: string): Record<string, unknown> {
  const m = /```json\n([\s\S]*?)\n```/.exec(text);
  if (!m?.[1]) return {};
  return JSON.parse(m[1]) as Record<string, unknown>;
}

describe("create_ai_texture", () => {
  it("generates, caches to disk, and drops a Movie File In TOP at the absolute cache path", async () => {
    const cacheDir = await freshCacheDir();
    const config = loadConfig({}, { overrides: { imageCacheDir: cacheDir } });
    const ctx = buildToolContext(config, { imageGen: fakeProvider() });
    const bodies = captureCreateBodies();

    const result = await createAiTextureImpl(ctx, makeArgs());
    expect(result.isError).toBeFalsy();

    // The Movie File In TOP is created with the ABSOLUTE cache path as its `file`.
    const clip = bodies.find((b) => b.type === "moviefileinTOP");
    expect(clip?.name).toBe("ai_texture");
    const cachePath = clip?.parameters?.file as string;
    expect(cachePath).toBeDefined();
    expect(cachePath.startsWith(cacheDir)).toBe(true);
    expect(clip?.parameters?.play).toBe(1);

    // The cache file actually exists on disk under the tmp dir.
    expect(existsSync(cachePath)).toBe(true);

    // The result carries the node path + cache path (+ provider/model, cache_hit=false).
    const text = textOf(result);
    expect(text).toContain("/project1/ai_texture");
    expect(text).toContain(cachePath);
    const report = jsonBlock(text);
    expect(report.node).toBe("/project1/ai_texture");
    expect(report.cache_path).toBe(cachePath);
    expect(report.provider).toBe("fal");
    expect(report.cache_hit).toBe(false);
  });

  it("returns a TDMCP_FAL_KEY error and makes ZERO bridge requests when imageGen is unset", async () => {
    const cacheDir = await freshCacheDir();
    const config = loadConfig({}, { overrides: { imageCacheDir: cacheDir } });
    const ctx = buildToolContext(config); // no imageGen override → provider "none" → undefined

    let bridgeRequests = 0;
    const countRequest = () => {
      bridgeRequests += 1;
    };
    server.events.on("request:start", countRequest);
    try {
      const result = await createAiTextureImpl(ctx, makeArgs());
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("TDMCP_FAL_KEY");
      expect(bridgeRequests).toBe(0);
    } finally {
      server.events.removeListener("request:start", countRequest);
    }
  });

  it("keeps the cached asset and cites its path when the bridge fails to create the node", async () => {
    const cacheDir = await freshCacheDir();
    const config = loadConfig({}, { overrides: { imageCacheDir: cacheDir } });
    const ctx = buildToolContext(config, { imageGen: fakeProvider() });

    // Bridge rejects the create_node call with a 500.
    server.use(
      http.post(`${TD_BASE}/api/nodes`, () =>
        HttpResponse.json({ ok: false, error: { message: "boom" } }, { status: 500 }),
      ),
    );

    const result = await createAiTextureImpl(ctx, makeArgs());
    expect(result.isError).toBe(true);

    const text = textOf(result);
    const report = jsonBlock(text);
    const cachePath = report.cache_path as string;
    expect(cachePath).toBeDefined();
    expect(text).toContain(cachePath);
    // The asset is not lost — the cache file survives a failed delivery.
    expect(existsSync(cachePath)).toBe(true);
    expect(cachePath.startsWith(cacheDir)).toBe(true);
  });

  it("validates inputs at the schema boundary and applies the documented defaults", () => {
    expect(() => createAiTextureSchema.parse({})).toThrow(); // prompt required
    expect(() => createAiTextureSchema.parse({ prompt: "" })).toThrow(); // min(1)
    expect(() => createAiTextureSchema.parse({ prompt: "x", width: 32 })).toThrow(); // < 64
    const parsed = createAiTextureSchema.parse({ prompt: "x" });
    expect(parsed.width).toBe(1024);
    expect(parsed.height).toBe(1024);
    expect(parsed.play).toBe(true);
    expect(parsed.name).toBe("ai_texture");
    expect(parsed.parent_path).toBe("/project1");
    expect(parsed.num_images).toBe(1);
  });
});

describe("create_ai_texture — texture pack (num_images > 1)", () => {
  it("generates N distinct images and tiles them into a Layout grid inside a baseCOMP", async () => {
    const cacheDir = await freshCacheDir();
    const config = loadConfig({}, { overrides: { imageCacheDir: cacheDir } });
    const ctx = buildToolContext(config, { imageGen: fakeProvider() });
    const bodies = captureCreateBodies();
    const connects = captureConnectBodies();

    const result = await createAiTextureImpl(ctx, makeArgs({ num_images: 4 }));
    expect(result.isError).toBeFalsy();

    // A fresh baseCOMP holds the pack.
    const container = bodies.find((b) => b.type === "baseCOMP");
    expect(container?.name).toBe("ai_texture");

    // 4 Movie File In TOPs, each pointed at an ABSOLUTE cache path under the tmp dir.
    const sources = bodies.filter((b) => b.type === "moviefileinTOP");
    expect(sources).toHaveLength(4);
    const files = sources.map((b) => b.parameters?.file as string);
    for (const file of files) {
      expect(file.startsWith(cacheDir)).toBe(true);
      expect(existsSync(file)).toBe(true);
    }
    // Distinct seeds ⇒ distinct cache keys ⇒ 4 distinct files (no seed-collapse).
    expect(new Set(files).size).toBe(4);

    // A Layout grid + a Null output tap.
    expect(bodies.filter((b) => b.type === "layoutTOP")).toHaveLength(1);
    expect(bodies.filter((b) => b.type === "nullTOP")).toHaveLength(1);

    // Each of the 4 sources wires into a distinct Layout-grid input slot.
    const toGrid = connects.filter((c) => c.target_path.endsWith("/grid"));
    expect(toGrid).toHaveLength(4);
    expect(toGrid.map((c) => c.target_input).sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);

    // finalize carries the pack manifest.
    const report = jsonBlock(textOf(result));
    expect(report.count).toBe(4);
    expect(report.pack).toHaveLength(4);
    expect(report.cache_paths).toHaveLength(4);
  });

  it("derives seed base+i so a passed seed is reproducible and image 0 == the single-image result", async () => {
    // Single image at seed 100 in its own cache dir → the P0 cache key for that seed.
    const singleDir = await freshCacheDir();
    const singleCfg = loadConfig({}, { overrides: { imageCacheDir: singleDir } });
    const singleCtx = buildToolContext(singleCfg, { imageGen: fakeProvider() });
    const single = await createAiTextureImpl(singleCtx, makeArgs({ num_images: 1, seed: 100 }));
    const singlePath = jsonBlock(textOf(single)).cache_path as string;

    // Pack of 3 at seed 100 in a separate cache dir, spying the seeds the provider sees.
    const packDir = await freshCacheDir();
    const packCfg = loadConfig({}, { overrides: { imageCacheDir: packDir } });
    const seeds: Array<number | undefined> = [];
    const packCtx = buildToolContext(packCfg, { imageGen: spyProvider(seeds) });
    const pack = await createAiTextureImpl(packCtx, makeArgs({ num_images: 3, seed: 100 }));
    expect(pack.isError).toBeFalsy();

    // The three requests carried seeds 100, 101, 102 (base + i).
    expect(seeds).toEqual([100, 101, 102]);

    // Image 0 hashes to the same cache key as the single-image seed-100 result
    // (different dir, identical filename ⇒ identical key ⇒ byte-identical).
    const cachePaths = jsonBlock(textOf(pack)).cache_paths as string[];
    const image0 = cachePaths[0];
    expect(image0).toBeDefined();
    if (image0) expect(basename(image0)).toBe(basename(singlePath));
  });

  it("leaves the num_images === 1 path on the byte-identical P0 single-TOP behavior", async () => {
    const cacheDir = await freshCacheDir();
    const config = loadConfig({}, { overrides: { imageCacheDir: cacheDir } });
    const ctx = buildToolContext(config, { imageGen: fakeProvider() });
    const bodies = captureCreateBodies();

    const result = await createAiTextureImpl(ctx, makeArgs({ num_images: 1 }));
    expect(result.isError).toBeFalsy();

    // Exactly one Movie File In TOP at parent_path, named args.name — no container, no grid.
    const sources = bodies.filter((b) => b.type === "moviefileinTOP");
    expect(sources).toHaveLength(1);
    expect(sources[0]?.parent_path).toBe("/project1");
    expect(sources[0]?.name).toBe("ai_texture");
    expect(bodies.some((b) => b.type === "baseCOMP")).toBe(false);
    expect(bodies.some((b) => b.type === "layoutTOP")).toBe(false);
  });

  it("returns a TDMCP_FAL_KEY error with zero bridge requests and zero cache files for a batch", async () => {
    const cacheDir = await freshCacheDir();
    const config = loadConfig({}, { overrides: { imageCacheDir: cacheDir } });
    const ctx = buildToolContext(config); // provider "none" → undefined

    let bridgeRequests = 0;
    const countRequest = () => {
      bridgeRequests += 1;
    };
    server.events.on("request:start", countRequest);
    try {
      const result = await createAiTextureImpl(ctx, makeArgs({ num_images: 4 }));
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("TDMCP_FAL_KEY");
      expect(bridgeRequests).toBe(0);
      expect(readdirSync(cacheDir)).toHaveLength(0);
    } finally {
      server.events.removeListener("request:start", countRequest);
    }
  });

  it("aborts on the first generation failure, citing already-cached paths and building no network", async () => {
    const cacheDir = await freshCacheDir();
    const config = loadConfig({}, { overrides: { imageCacheDir: cacheDir } });
    const ctx = buildToolContext(config, { imageGen: throwOnNthProvider(3) });
    const bodies = captureCreateBodies();

    const result = await createAiTextureImpl(ctx, makeArgs({ num_images: 4 }));
    expect(result.isError).toBe(true);

    // Two images were cached before the 3rd threw; both are cited and on disk.
    const report = jsonBlock(textOf(result));
    const cached = report.cached_so_far as string[];
    expect(cached).toHaveLength(2);
    for (const path of cached) {
      expect(textOf(result)).toContain(path);
      expect(existsSync(path)).toBe(true);
    }
    expect(readdirSync(cacheDir)).toHaveLength(2);
    // No TD build was attempted — not even the container.
    expect(bodies).toHaveLength(0);
  });

  it("keeps all N cached assets and cites every path when the bridge fails after generation", async () => {
    const cacheDir = await freshCacheDir();
    const config = loadConfig({}, { overrides: { imageCacheDir: cacheDir } });
    const ctx = buildToolContext(config, { imageGen: fakeProvider() });

    // The bridge 500s on every create_node (container + sources).
    server.use(
      http.post(`${TD_BASE}/api/nodes`, () =>
        HttpResponse.json({ ok: false, error: { message: "boom" } }, { status: 500 }),
      ),
    );

    const result = await createAiTextureImpl(ctx, makeArgs({ num_images: 4 }));
    expect(result.isError).toBe(true);

    const report = jsonBlock(textOf(result));
    const cachePaths = report.cache_paths as string[];
    expect(cachePaths).toHaveLength(4);
    for (const path of cachePaths) {
      expect(textOf(result)).toContain(path);
      expect(existsSync(path)).toBe(true);
    }
    // All 4 images survive the failed build.
    expect(readdirSync(cacheDir)).toHaveLength(4);
  });
});
