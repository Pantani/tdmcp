import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

function makeArgs(over: Partial<CreateAiTextureArgs> = {}): CreateAiTextureArgs {
  return {
    prompt: "a neon jellyfish drifting through fog",
    width: 1024,
    height: 1024,
    play: true,
    name: "ai_texture",
    parent_path: "/project1",
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
  });
});
