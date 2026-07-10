import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildToolContext } from "../../src/server/context.js";
import { FalVideoProvider } from "../../src/services/videoGen/falProvider.js";
import type { VideoGenProvider } from "../../src/services/videoGen/types.js";
import {
  type CreateAiVideoArgs,
  createAiVideoImpl,
  createAiVideoSchema,
  type VideoToolContext,
} from "../../src/tools/layer2/createAiVideo.js";
import { loadConfig } from "../../src/utils/config.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

const server = makeTdServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// A tiny "mp4" payload — the cache only cares that real bytes land on disk.
const MP4_BYTES = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]);

const tmpDirs: string[] = [];
async function freshCacheDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tdmcp-ai-video-"));
  tmpDirs.push(dir);
  return dir;
}
afterAll(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

/** Build a ctx with the video-lane fields the integrator will add to ToolContext. */
function videoCtx(cacheDir: string, provider: VideoGenProvider | undefined): VideoToolContext {
  const config = loadConfig({});
  const ctx = buildToolContext(config) as VideoToolContext;
  ctx.videoGen = provider;
  ctx.videoCacheDir = cacheDir;
  return ctx;
}

/** A no-network provider that returns real mp4 bytes and counts its calls. */
function fakeProvider(): VideoGenProvider & { calls: number } {
  return {
    id: "fal",
    defaultModel: "ltx-video",
    calls: 0,
    async generate(req) {
      this.calls += 1;
      return {
        bytes: MP4_BYTES,
        mimeType: "video/mp4",
        provider: "fal",
        model: req.model ?? "ltx-video",
        durationSec: req.durationSeconds,
        seed: req.seed,
        costUsd: 0.02,
      };
    },
  };
}

function makeArgs(over: Partial<CreateAiVideoArgs> = {}): CreateAiVideoArgs {
  return {
    prompt: "a neon jellyfish drifting through fog, slow drift",
    model: "ltx-video",
    duration_seconds: 5,
    resolution: "768x512",
    guidance_scale: 3,
    num_inference_steps: 30,
    name: "ai_video",
    play: true,
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

/** Mock the fal queue flow for a text-to-video slug + the CDN clip download. */
function mockFalQueue(slug: string): void {
  server.use(
    http.post(`https://queue.fal.run/${slug}`, () =>
      HttpResponse.json({
        status_url: "https://queue.fal.run/status/abc",
        response_url: "https://queue.fal.run/response/abc",
      }),
    ),
    http.get("https://queue.fal.run/status/abc", () => HttpResponse.json({ status: "COMPLETED" })),
    http.get("https://queue.fal.run/response/abc", () =>
      HttpResponse.json({
        video: { url: "https://cdn.fal.example/clip.mp4", content_type: "video/mp4" },
        seed: 7,
      }),
    ),
    http.get("https://cdn.fal.example/clip.mp4", () =>
      HttpResponse.arrayBuffer(MP4_BYTES.buffer as ArrayBuffer, {
        headers: { "content-type": "video/mp4" },
      }),
    ),
  );
}

describe("create_ai_video", () => {
  it("generates via the fake provider, caches to disk, and drops a Movie File In TOP at the absolute path", async () => {
    const cacheDir = await freshCacheDir();
    const ctx = videoCtx(cacheDir, fakeProvider());
    const bodies = captureCreateBodies();

    const result = await createAiVideoImpl(ctx, makeArgs());
    expect(result.isError).toBeFalsy();

    const clip = bodies.find((b) => b.type === "moviefileinTOP");
    expect(clip?.name).toBe("ai_video");
    const cachePath = clip?.parameters?.file as string;
    expect(cachePath.startsWith(cacheDir)).toBe(true);
    expect(clip?.parameters?.play).toBe(1);
    expect(existsSync(cachePath)).toBe(true);

    const report = jsonBlock(textOf(result));
    expect(report.node).toBe("/project1/ai_video");
    expect(report.cache_path).toBe(cachePath);
    expect(report.provider).toBe("fal");
    expect(report.cache_hit).toBe(false);
    expect(report.cost_usd).toBe(0.02);
  });

  it("reuses the cached clip on a second identical request (no second provider call)", async () => {
    const cacheDir = await freshCacheDir();
    const provider = fakeProvider();
    const ctx = videoCtx(cacheDir, provider);
    captureCreateBodies();

    await createAiVideoImpl(ctx, makeArgs());
    const second = await createAiVideoImpl(ctx, makeArgs());
    expect(provider.calls).toBe(1);
    expect(jsonBlock(textOf(second)).cache_hit).toBe(true);
  });

  it("runs the real fal queue flow (submit → status → response → download) end to end", async () => {
    const cacheDir = await freshCacheDir();
    const provider = new FalVideoProvider("fake-key", { defaultModel: "ltx-video" });
    const ctx = videoCtx(cacheDir, provider);
    const bodies = captureCreateBodies();
    mockFalQueue("fal-ai/ltx-video/text-to-video");

    const result = await createAiVideoImpl(ctx, makeArgs());
    expect(result.isError).toBeFalsy();
    const clip = bodies.find((b) => b.type === "moviefileinTOP");
    const cachePath = clip?.parameters?.file as string;
    expect(existsSync(cachePath)).toBe(true);
    expect(jsonBlock(textOf(result)).provider).toBe("fal");
  });

  it("uploads the init image to fal storage and takes the image-to-video slug", async () => {
    const cacheDir = await freshCacheDir();
    const initImage = join(cacheDir, "anchor.png");
    await writeFile(initImage, MP4_BYTES);
    const provider = new FalVideoProvider("fake-key", { defaultModel: "ltx-video" });
    const ctx = videoCtx(cacheDir, provider);
    captureCreateBodies();

    let uploaded = false;
    server.use(
      http.post("https://rest.alpha.fal.ai/storage/upload", () => {
        uploaded = true;
        return HttpResponse.json({ url: "https://cdn.fal.example/anchor.png" });
      }),
    );
    mockFalQueue("fal-ai/ltx-video/image-to-video");

    const result = await createAiVideoImpl(ctx, makeArgs({ init_image: initImage }));
    expect(result.isError).toBeFalsy();
    expect(uploaded).toBe(true);
  });

  it("returns a provider error and makes ZERO bridge requests when videoGen is unset", async () => {
    const cacheDir = await freshCacheDir();
    const ctx = videoCtx(cacheDir, undefined);

    let bridgeRequests = 0;
    const countRequest = () => {
      bridgeRequests += 1;
    };
    server.events.on("request:start", countRequest);
    try {
      const result = await createAiVideoImpl(ctx, makeArgs());
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("TDMCP_VIDEO_GEN_PROVIDER");
      expect(bridgeRequests).toBe(0);
    } finally {
      server.events.removeListener("request:start", countRequest);
    }
  });

  it("rejects an explicit provider that differs from the resolved one, building nothing", async () => {
    const cacheDir = await freshCacheDir();
    const ctx = videoCtx(cacheDir, fakeProvider()); // resolved id === "fal"

    let bridgeRequests = 0;
    const countRequest = () => {
      bridgeRequests += 1;
    };
    server.events.on("request:start", countRequest);
    try {
      const result = await createAiVideoImpl(ctx, makeArgs({ provider: "comfyui" }));
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("comfyui");
      expect(bridgeRequests).toBe(0);
    } finally {
      server.events.removeListener("request:start", countRequest);
    }
  });

  it("cites the cache path when the bridge fails to create the node", async () => {
    const cacheDir = await freshCacheDir();
    const ctx = videoCtx(cacheDir, fakeProvider());
    server.use(
      http.post(`${TD_BASE}/api/nodes`, () =>
        HttpResponse.json({ ok: false, error: { message: "boom" } }, { status: 500 }),
      ),
    );

    const result = await createAiVideoImpl(ctx, makeArgs());
    expect(result.isError).toBe(true);
    const cachePath = jsonBlock(textOf(result)).cache_path as string;
    expect(existsSync(cachePath)).toBe(true);
    expect(cachePath.startsWith(cacheDir)).toBe(true);
  });

  it("enforces the schema refinements (ltx-video 5s lock, 4k only on ltx-2)", () => {
    expect(() => createAiVideoSchema.parse({ prompt: "x", duration_seconds: 6 })).toThrow();
    expect(() => createAiVideoSchema.parse({ prompt: "x", resolution: "4k" })).toThrow(); // 4k on default ltx-video
    // Valid: ltx-2 unlocks 4k and variable duration.
    const ok = createAiVideoSchema.parse({
      prompt: "x",
      model: "ltx-2",
      resolution: "4k",
      duration_seconds: 8,
    });
    expect(ok.resolution).toBe("4k");
    expect(ok.duration_seconds).toBe(8);
    // Defaults on a bare prompt.
    const base = createAiVideoSchema.parse({ prompt: "x" });
    expect(base.model).toBe("ltx-video");
    expect(base.duration_seconds).toBe(5);
    expect(base.resolution).toBe("768x512");
    expect(base.play).toBe(true);
    expect(base.name).toBe("ai_video");
  });
});
