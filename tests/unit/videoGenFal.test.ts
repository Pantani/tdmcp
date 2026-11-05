import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { FalVideoProvider } from "../../src/services/videoGen/falProvider.js";
import type { VideoGenRequest } from "../../src/services/videoGen/types.js";

const QUEUE = "https://queue.fal.run";
const STORAGE = "https://rest.alpha.fal.ai/storage/upload";
const CLIP = "https://cdn.fal.example/out.mp4";
const MP4 = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]);

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function provider(model = "ltx-video"): FalVideoProvider {
  return new FalVideoProvider("test-key", { defaultModel: model });
}

function baseReq(over: Partial<VideoGenRequest> = {}): VideoGenRequest {
  return { prompt: "a slow bloom", model: "ltx-video", durationSeconds: 5, ...over };
}

interface FalResultBody {
  video?: { url?: string; content_type?: string };
  videos?: Array<{ url?: string; content_type?: string }>;
  seed?: number;
  metrics?: { cost?: number };
}

/** Mock submit → status COMPLETED → result → clip download. `result` shapes the response JSON. */
function mockQueue(result: FalResultBody, capturedSlug?: { slug?: string; input?: unknown }): void {
  server.use(
    http.post(`${QUEUE}/:owner/:model/*`, async ({ request }) => {
      if (capturedSlug) {
        capturedSlug.slug = new URL(request.url).pathname.replace(/^\//, "");
        capturedSlug.input = await request.json();
      }
      return HttpResponse.json({
        status_url: `${QUEUE}/status/1`,
        response_url: `${QUEUE}/response/1`,
      });
    }),
    http.get(`${QUEUE}/status/1`, () => HttpResponse.json({ status: "COMPLETED" })),
    http.get(`${QUEUE}/response/1`, () => HttpResponse.json(result)),
    http.get(CLIP, () =>
      HttpResponse.arrayBuffer(MP4.buffer as ArrayBuffer, {
        headers: { "content-type": "video/mp4" },
      }),
    ),
  );
}

describe("FalVideoProvider queue path", () => {
  it("text-to-video: resolves the t2v slug and returns clip bytes + flat cost", async () => {
    const cap: { slug?: string; input?: unknown } = {};
    mockQueue({ video: { url: CLIP }, seed: 7 }, cap);

    const res = await provider().generate(baseReq());

    expect(cap.slug).toContain("text-to-video");
    expect(res.provider).toBe("fal");
    expect(res.mimeType).toBe("video/mp4");
    expect(res.bytes.byteLength).toBe(MP4.byteLength);
    expect(res.costUsd).toBe(0.02); // ltx-video flat cost
    expect(res.seed).toBe(7);
  });

  it("handles the videos[] result shape and metrics cost", async () => {
    mockQueue({ videos: [{ url: CLIP, content_type: "video/webm" }], metrics: { cost: 0.09 } });
    const res = await provider().generate(baseReq());
    expect(res.mimeType).toBe("video/webm");
    expect(res.costUsd).toBe(0.09);
  });

  it("image-to-video: uploads the init image then resolves the i2v slug", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fal-i2v-"));
    const img = join(dir, "seed.png");
    await writeFile(img, MP4);
    const cap: { slug?: string; input?: unknown } = {};
    server.use(
      http.post(STORAGE, () => HttpResponse.json({ url: "https://cdn.fal.example/seed.png" })),
    );
    mockQueue({ video: { url: CLIP } }, cap);

    const res = await provider().generate(baseReq({ initImagePath: img }));

    expect(cap.slug).toContain("image-to-video");
    expect((cap.input as { image_url?: string }).image_url).toBe(
      "https://cdn.fal.example/seed.png",
    );
    expect(res.provider).toBe("fal");
    await rm(dir, { recursive: true, force: true });
  });

  it("throws when the fal response carries no video URL", async () => {
    mockQueue({ videos: [] });
    await expect(provider().generate(baseReq())).rejects.toThrow(/no video URL/);
  });

  it("throws a helpful error on a non-2xx queue submit", async () => {
    server.use(
      http.post(`${QUEUE}/:owner/:model/*`, () => new HttpResponse("nope", { status: 500 })),
    );
    await expect(provider().generate(baseReq())).rejects.toThrow(
      /fal queue submit returned HTTP 500/,
    );
  });

  it("throws when submit omits status_url/response_url", async () => {
    server.use(http.post(`${QUEUE}/:owner/:model/*`, () => HttpResponse.json({ request_id: "x" })));
    await expect(provider().generate(baseReq())).rejects.toThrow(/missing status_url/);
  });

  it("throws when the init-image upload fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fal-up-"));
    const img = join(dir, "seed.png");
    await writeFile(img, MP4);
    server.use(http.post(STORAGE, () => new HttpResponse("bad", { status: 413 })));
    await expect(provider().generate(baseReq({ initImagePath: img }))).rejects.toThrow(
      /fal storage upload returned HTTP 413/,
    );
    await rm(dir, { recursive: true, force: true });
  });

  it("throws when the upload response omits a file URL", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fal-up2-"));
    const img = join(dir, "seed.png");
    await writeFile(img, MP4);
    server.use(http.post(STORAGE, () => HttpResponse.json({})));
    await expect(provider().generate(baseReq({ initImagePath: img }))).rejects.toThrow(
      /missing a file URL/,
    );
    await rm(dir, { recursive: true, force: true });
  });

  it("throws on a non-2xx status poll", async () => {
    server.use(
      http.post(`${QUEUE}/:owner/:model/*`, () =>
        HttpResponse.json({ status_url: `${QUEUE}/status/1`, response_url: `${QUEUE}/response/1` }),
      ),
      http.get(`${QUEUE}/status/1`, () => new HttpResponse("boom", { status: 502 })),
    );
    await expect(provider().generate(baseReq())).rejects.toThrow(
      /fal queue status returned HTTP 502/,
    );
  });

  it("throws on a non-2xx result fetch", async () => {
    server.use(
      http.post(`${QUEUE}/:owner/:model/*`, () =>
        HttpResponse.json({ status_url: `${QUEUE}/status/1`, response_url: `${QUEUE}/response/1` }),
      ),
      http.get(`${QUEUE}/status/1`, () => HttpResponse.json({ status: "COMPLETED" })),
      http.get(`${QUEUE}/response/1`, () => new HttpResponse("err", { status: 500 })),
    );
    await expect(provider().generate(baseReq())).rejects.toThrow(
      /fal queue result returned HTTP 500/,
    );
  });

  it("throws on a non-2xx clip download", async () => {
    server.use(
      http.post(`${QUEUE}/:owner/:model/*`, () =>
        HttpResponse.json({ status_url: `${QUEUE}/status/1`, response_url: `${QUEUE}/response/1` }),
      ),
      http.get(`${QUEUE}/status/1`, () => HttpResponse.json({ status: "COMPLETED" })),
      http.get(`${QUEUE}/response/1`, () => HttpResponse.json({ video: { url: CLIP } })),
      http.get(CLIP, () => new HttpResponse("gone", { status: 404 })),
    );
    await expect(provider().generate(baseReq())).rejects.toThrow(
      /fal video download returned HTTP 404/,
    );
  });

  it("resolves the ltx-2 slug for the ltx-2 model", async () => {
    const cap: { slug?: string; input?: unknown } = {};
    mockQueue({ video: { url: CLIP } }, cap);
    await provider("ltx-2").generate(baseReq({ model: "ltx-2" }));
    expect(cap.slug).toContain("ltx-2");
  });
});
