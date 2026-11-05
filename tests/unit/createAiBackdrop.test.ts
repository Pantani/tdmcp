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
  type CreateAiBackdropArgs,
  createAiBackdropImpl,
} from "../../src/tools/layer1/createAiBackdrop.js";
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
  const dir = await mkdtemp(join(tmpdir(), "tdmcp-ai-backdrop-"));
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

// Defaulted schema fields are REQUIRED when calling the impl directly (no Zod parse).
function makeArgs(over: Partial<CreateAiBackdropArgs> = {}): CreateAiBackdropArgs {
  return {
    prompt: "a vast bioluminescent cave, volumetric fog",
    width: 1920,
    height: 1080,
    brightness: 1,
    blur: 0,
    scale: 1,
    expose_controls: true,
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

/** Records every POST /api/nodes body so a test can assert what was created + with which params. */
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

/** Records every /api/exec script so a test can decode the exposed control panel payload. */
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

describe("create_ai_backdrop", () => {
  it("caches the image, builds the wired backdrop container, and exposes Brightness/Blur/Scale controls", async () => {
    const cacheDir = await freshCacheDir();
    const config = loadConfig({}, { overrides: { imageCacheDir: cacheDir } });
    const ctx = buildToolContext(config, { imageGen: fakeProvider() });
    const bodies = captureCreateBodies();
    const scripts = captureExecScripts();

    const result = await createAiBackdropImpl(ctx, makeArgs());
    expect(result.isError).toBeFalsy();

    // The whole backdrop chain was created inside a fresh ai_backdrop baseCOMP.
    expect(bodies.find((b) => b.name === "ai_backdrop")?.type).toBe("baseCOMP");
    const src = bodies.find((b) => b.name === "backdrop");
    expect(src?.type).toBe("moviefileinTOP");
    expect(bodies.find((b) => b.name === "grade")?.type).toBe("levelTOP");
    expect(bodies.find((b) => b.name === "frame")?.type).toBe("transformTOP");
    expect(bodies.find((b) => b.name === "soft")?.type).toBe("blurTOP");
    expect(bodies.find((b) => b.name === "out1")?.type).toBe("nullTOP");

    // The Movie File In TOP points at the ABSOLUTE cache path and plays on arrival.
    const cachePath = src?.parameters?.file as string;
    expect(cachePath).toBeDefined();
    expect(cachePath.startsWith(cacheDir)).toBe(true);
    expect(src?.parameters?.play).toBe(1);
    // The cache file actually exists on disk under the tmp dir.
    expect(existsSync(cachePath)).toBe(true);

    // The finalize result carries the container + output paths and the cache path.
    const text = textOf(result);
    expect(text).toContain("/project1/ai_backdrop");
    expect(text).toContain("/project1/ai_backdrop/out1");
    const report = jsonBlock(text);
    expect(report.output).toBe("/project1/ai_backdrop/out1");
    expect(report.cache_path).toBe(cachePath);
    expect(report.provider).toBe("fal");

    // The exposed control panel binds Brightness/Blur/Scale to the right node params.
    const panel = scripts.find((s) => s.includes("appendCustomPage"));
    expect(panel).toBeDefined();
    const b64 = /b64decode\("([^"]+)"\)/.exec(panel ?? "")?.[1];
    if (b64 === undefined) throw new Error("panel script did not embed a base64 payload");
    const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as {
      controls: Array<{ name: string; bind_to?: string[] }>;
    };
    const by = (name: string) => payload.controls.find((c) => c.name === name);
    expect(by("Brightness")?.bind_to?.[0]).toMatch(/grade\.brightness1$/);
    expect(by("Blur")?.bind_to?.[0]).toMatch(/soft\.size$/);
    // The Scale knob drives BOTH transform axes.
    expect(by("Scale")?.bind_to).toEqual([
      expect.stringMatching(/frame\.sx$/),
      expect.stringMatching(/frame\.sy$/),
    ]);
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
      const result = await createAiBackdropImpl(ctx, makeArgs());
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("TDMCP_FAL_KEY");
      // Nothing was built: no createSystemContainer / TD call at all.
      expect(bridgeRequests).toBe(0);
    } finally {
      server.events.removeListener("request:start", countRequest);
    }
  });

  it("keeps the cached asset and cites its path when the container build fails", async () => {
    const cacheDir = await freshCacheDir();
    const config = loadConfig({}, { overrides: { imageCacheDir: cacheDir } });
    const ctx = buildToolContext(config, { imageGen: fakeProvider() });

    // Bridge rejects the very first create_node (the ai_backdrop container) with a 500.
    server.use(
      http.post(`${TD_BASE}/api/nodes`, () =>
        HttpResponse.json({ ok: false, error: { message: "boom" } }, { status: 500 }),
      ),
    );

    const result = await createAiBackdropImpl(ctx, makeArgs());
    expect(result.isError).toBe(true);

    const text = textOf(result);
    const report = jsonBlock(text);
    const cachePath = report.cache_path as string;
    expect(cachePath).toBeDefined();
    expect(text).toContain(cachePath);
    // The asset is not lost — the cache file survives a failed build.
    expect(existsSync(cachePath)).toBe(true);
    expect(cachePath.startsWith(cacheDir)).toBe(true);
  });
});
