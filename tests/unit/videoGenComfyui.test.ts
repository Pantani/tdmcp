import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { videoCacheKey, writeCachedVideo } from "../../src/services/videoGen/cache.js";
import { ComfyuiVideoProvider } from "../../src/services/videoGen/comfyuiProvider.js";
import type { VideoGenRequest } from "../../src/services/videoGen/types.js";

const COMFY = "http://127.0.0.1:8188";
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const MP4_BYTES = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]);

const tmpDirs: string[] = [];
async function freshDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tdmcp-comfyui-"));
  tmpDirs.push(dir);
  return dir;
}
afterAll(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

/** A minimal API-format LTX-Video workflow with the well-known injectable inputs. */
function fixtureWorkflow(): Record<string, unknown> {
  return {
    "3": { class_type: "KSampler", inputs: { seed: 0, steps: 20, cfg: 7.0 } },
    "6": {
      class_type: "CLIPTextEncode",
      inputs: { text: "PLACEHOLDER" },
      _meta: { title: "Positive" },
    },
    "7": {
      class_type: "CLIPTextEncode",
      inputs: { text: "PLACEHOLDER" },
      _meta: { title: "Negative" },
    },
    "10": { class_type: "EmptyLTXVLatentVideo", inputs: { length: 25 } },
    "12": { class_type: "LoadImage", inputs: { image: "placeholder.png" } },
    "20": { class_type: "SaveVideo", inputs: {} },
  };
}

async function writeWorkflow(dir: string): Promise<string> {
  const path = join(dir, "workflow.json");
  await writeFile(path, JSON.stringify(fixtureWorkflow()));
  return path;
}

interface SubmittedGraph {
  graph?: Record<string, { inputs?: Record<string, unknown> }>;
}

/** Mock the full REST round-trip; capture the submitted /prompt graph for assertions. */
function mockComfy(captured: SubmittedGraph, opts: { withUpload?: boolean } = {}): void {
  if (opts.withUpload) {
    server.use(http.post(`${COMFY}/upload/image`, () => HttpResponse.json({ name: "anchor.png" })));
  }
  server.use(
    http.post(`${COMFY}/prompt`, async ({ request }) => {
      const body = (await request.json()) as { prompt?: SubmittedGraph["graph"] };
      captured.graph = body.prompt;
      return HttpResponse.json({ prompt_id: "pid-1" });
    }),
    http.get(`${COMFY}/history/pid-1`, () =>
      HttpResponse.json({
        "pid-1": {
          outputs: {
            "20": { videos: [{ filename: "out.mp4", subfolder: "vid", type: "output" }] },
          },
        },
      }),
    ),
    http.get(`${COMFY}/view`, () =>
      HttpResponse.arrayBuffer(MP4_BYTES.buffer as ArrayBuffer, {
        headers: { "content-type": "video/mp4" },
      }),
    ),
  );
}

function baseReq(over: Partial<VideoGenRequest> = {}): VideoGenRequest {
  return {
    prompt: "a slow neon bloom unfurling",
    negativePrompt: "blurry, low quality",
    model: "ltx-video",
    durationSeconds: 5,
    guidanceScale: 4,
    numInferenceSteps: 28,
    seed: 42,
    ...over,
  };
}

describe("ComfyuiVideoProvider", () => {
  it("injects prompt/duration/steps/seed into the graph and downloads the clip bytes", async () => {
    const dir = await freshDir();
    const workflow = await writeWorkflow(dir);
    const provider = new ComfyuiVideoProvider(COMFY, workflow);
    const captured: SubmittedGraph = {};
    mockComfy(captured);

    const result = await provider.generate(baseReq());

    // The submitted graph carries the injected values.
    const g = captured.graph ?? {};
    expect(g["6"]?.inputs?.text).toBe("a slow neon bloom unfurling");
    expect(g["7"]?.inputs?.text).toBe("blurry, low quality"); // negative node
    expect(g["3"]?.inputs?.seed).toBe(42);
    expect(g["3"]?.inputs?.steps).toBe(28);
    expect(g["3"]?.inputs?.cfg).toBe(4);
    // `length` is FRAMES (seconds * 24, snapped to k*8+1): 5s -> 121, not 5.
    expect(g["10"]?.inputs?.length).toBe(121);

    // The result is a local, free clip fully downloaded into bytes.
    expect(result.provider).toBe("comfyui");
    expect(result.mimeType).toBe("video/mp4");
    expect(result.costUsd).toBeUndefined();
    expect(result.bytes.byteLength).toBe(MP4_BYTES.byteLength);

    // The bytes write to an ABSOLUTE cache path.
    const key = videoCacheKey(baseReq(), provider.id, "ltx-video");
    const cachePath = await writeCachedVideo(dir, key, result);
    expect(isAbsolute(cachePath)).toBe(true);
    expect(existsSync(cachePath)).toBe(true);
  });

  it("uploads an init image and references the stored filename in the LoadImage node", async () => {
    const dir = await freshDir();
    const workflow = await writeWorkflow(dir);
    const initImage = join(dir, "seed.png");
    await writeFile(initImage, MP4_BYTES);
    const provider = new ComfyuiVideoProvider(COMFY, workflow);
    const captured: SubmittedGraph = {};
    mockComfy(captured, { withUpload: true });

    await provider.generate(baseReq({ initImagePath: initImage }));
    expect(captured.graph?.["12"]?.inputs?.image).toBe("anchor.png");
  });

  it("throws a clear error when the workflow has no prompt node", async () => {
    const dir = await freshDir();
    const path = join(dir, "bad.json");
    await writeFile(path, JSON.stringify({ "1": { class_type: "SaveVideo", inputs: {} } }));
    const provider = new ComfyuiVideoProvider(COMFY, path);

    await expect(provider.generate(baseReq())).rejects.toThrow(/no text-prompt node/);
  });
});
