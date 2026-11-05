import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_FAL_MODEL, FalProvider } from "../../src/services/imageGen/falProvider.js";

// The fast (Flux-schnell) path posts to the synchronous fal.run endpoint and gets
// the result JSON back in one round-trip. fal returns an image URL, not raw bytes,
// so the provider does a second GET to download the bytes.
const SUBMIT_URL = `https://fal.run/${DEFAULT_FAL_MODEL}`;
const IMAGE_URL = "https://v3.fal.media/files/fake/generated.png";
// PNG magic bytes — proves the provider returns exactly what the image GET served.
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let capturedAuth: string | null = null;

const server = setupServer(
  http.post(SUBMIT_URL, ({ request }) => {
    capturedAuth = request.headers.get("authorization");
    return HttpResponse.json({
      images: [{ url: IMAGE_URL, width: 1024, height: 768, content_type: "image/png" }],
      seed: 42,
    });
  }),
  http.get(IMAGE_URL, () => HttpResponse.arrayBuffer(PNG_BYTES.buffer)),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
  capturedAuth = null;
});
afterAll(() => server.close());

function makeProvider(): FalProvider {
  return new FalProvider("fal-test-key", { defaultModel: DEFAULT_FAL_MODEL });
}

describe("FalProvider.generate", () => {
  it("submits, downloads the result URL into bytes, and echoes provider metadata", async () => {
    const image = await makeProvider().generate({
      prompt: "a neon cityscape",
      width: 1024,
      height: 768,
      seed: 42,
    });

    expect(image.provider).toBe("fal");
    expect(image.model).toBe(DEFAULT_FAL_MODEL);
    expect(image.mimeType).toBe("image/png");
    expect(image.seed).toBe(42);
    expect(image.bytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(image.bytes)).toEqual(Array.from(PNG_BYTES));
  });

  it("sends the fal auth header as `Key <key>` (not Bearer)", async () => {
    await makeProvider().generate({ prompt: "a portrait" });
    expect(capturedAuth).toBe("Key fal-test-key");
  });

  it("throws an Error whose message cites the HTTP status on a non-2xx submit", async () => {
    server.use(http.post(SUBMIT_URL, () => new HttpResponse("bad request", { status: 400 })));

    await expect(makeProvider().generate({ prompt: "boom" })).rejects.toThrow(/HTTP 400/);
  });
});
