import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildToolContext } from "../../src/server/context.js";
import type { VideoGenProvider } from "../../src/services/videoGen/types.js";
import {
  type CreateAiVideoBackdropArgs,
  createAiVideoBackdropImpl,
} from "../../src/tools/layer1/createAiVideoBackdrop.js";
import type { VideoToolContext } from "../../src/tools/layer2/createAiVideo.js";
import { loadConfig } from "../../src/utils/config.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

const server = makeTdServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const MP4_BYTES = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]);

const tmpDirs: string[] = [];
async function freshCacheDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tdmcp-ai-video-backdrop-"));
  tmpDirs.push(dir);
  return dir;
}
afterAll(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

function videoCtx(cacheDir: string, provider: VideoGenProvider | undefined): VideoToolContext {
  const config = loadConfig({});
  const ctx = buildToolContext(config) as VideoToolContext;
  ctx.videoGen = provider;
  ctx.videoCacheDir = cacheDir;
  return ctx;
}

function fakeProvider(): VideoGenProvider {
  return {
    id: "fal",
    defaultModel: "ltx-video",
    async generate(req) {
      return {
        bytes: MP4_BYTES,
        mimeType: "video/mp4",
        provider: "fal",
        model: req.model ?? "ltx-video",
        durationSec: req.durationSeconds,
        seed: req.seed,
      };
    },
  };
}

function makeArgs(over: Partial<CreateAiVideoBackdropArgs> = {}): CreateAiVideoBackdropArgs {
  return {
    prompt: "a vast bioluminescent cave, volumetric fog, slow camera push",
    model: "ltx-video",
    duration_seconds: 5,
    resolution: "768x512",
    guidance_scale: 3,
    num_inference_steps: 30,
    parent_path: "/project1",
    brightness: 1,
    scale: 1,
    blur: 0,
    play: true,
    speed: 1,
    expose_controls: true,
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

function captureExecScripts(): string[] {
  const scripts: string[] = [];
  server.use(
    http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
      scripts.push(((await request.json()) as { script: string }).script);
      return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
    }),
  );
  return scripts;
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

describe("create_ai_video_backdrop", () => {
  it("caches the clip, builds the wired container, and exposes Play/Speed/Brightness/Scale controls", async () => {
    const cacheDir = await freshCacheDir();
    const ctx = videoCtx(cacheDir, fakeProvider());
    const bodies = captureCreateBodies();
    const scripts = captureExecScripts();

    const result = await createAiVideoBackdropImpl(ctx, makeArgs());
    expect(result.isError).toBeFalsy();

    // The whole chain lives inside a fresh ai_video baseCOMP.
    expect(bodies.find((b) => b.name === "ai_video")?.type).toBe("baseCOMP");
    const src = bodies.find((b) => b.name === "clip");
    expect(src?.type).toBe("moviefileinTOP");
    expect(bodies.find((b) => b.name === "grade")?.type).toBe("levelTOP");
    expect(bodies.find((b) => b.name === "frame")?.type).toBe("transformTOP");
    expect(bodies.find((b) => b.name === "soft")?.type).toBe("blurTOP");
    expect(bodies.find((b) => b.name === "out1")?.type).toBe("nullTOP");

    // The Movie File In TOP points at the ABSOLUTE cache path and plays on arrival.
    const cachePath = src?.parameters?.file as string;
    expect(cachePath.startsWith(cacheDir)).toBe(true);
    expect(src?.parameters?.play).toBe(1);
    expect(src?.parameters?.speed).toBe(1);
    expect(existsSync(cachePath)).toBe(true);

    const report = jsonBlock(textOf(result));
    expect(report.output).toBe("/project1/ai_video/out1");
    expect(report.cache_path).toBe(cachePath);
    expect(report.provider).toBe("fal");

    // The exposed control panel binds the four controls to the right node params.
    const panel = scripts.find((s) => s.includes("appendCustomPage"));
    expect(panel).toBeDefined();
    const b64 = /b64decode\("([^"]+)"\)/.exec(panel ?? "")?.[1];
    if (b64 === undefined) throw new Error("panel script did not embed a base64 payload");
    const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as {
      controls: Array<{ name: string; type: string; bind_to?: string[] }>;
    };
    const by = (name: string) => payload.controls.find((c) => c.name === name);
    expect(by("Play")?.type).toBe("toggle");
    expect(by("Play")?.bind_to?.[0]).toMatch(/clip\.play$/);
    expect(by("Speed")?.bind_to?.[0]).toMatch(/clip\.speed$/);
    expect(by("Brightness")?.bind_to?.[0]).toMatch(/grade\.brightness1$/);
    expect(by("Scale")?.bind_to).toEqual([
      expect.stringMatching(/frame\.sx$/),
      expect.stringMatching(/frame\.sy$/),
    ]);
    expect(by("Blur")?.bind_to?.[0]).toMatch(/soft\.size$/);
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
      const result = await createAiVideoBackdropImpl(ctx, makeArgs());
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("TDMCP_VIDEO_GEN_PROVIDER");
      expect(bridgeRequests).toBe(0);
    } finally {
      server.events.removeListener("request:start", countRequest);
    }
  });

  it("keeps the cached asset and cites its path when the container build fails", async () => {
    const cacheDir = await freshCacheDir();
    const ctx = videoCtx(cacheDir, fakeProvider());
    server.use(
      http.post(`${TD_BASE}/api/nodes`, () =>
        HttpResponse.json({ ok: false, error: { message: "boom" } }, { status: 500 }),
      ),
    );

    const result = await createAiVideoBackdropImpl(ctx, makeArgs());
    expect(result.isError).toBe(true);
    const cachePath = jsonBlock(textOf(result)).cache_path as string;
    expect(existsSync(cachePath)).toBe(true);
    expect(cachePath.startsWith(cacheDir)).toBe(true);
  });
});
