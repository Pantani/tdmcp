import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_REPLICATE_MODEL,
  ReplicateProvider,
} from "../../src/services/imageGen/replicateProvider.js";
import { resolveImageProvider } from "../../src/services/imageGen/resolve.js";
import { silentLogger } from "../../src/utils/logger.js";

// flux-schnell is an official `owner/name` model → the model-create endpoint.
const CREATE_URL = "https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions";
// Poll endpoint the create response advertises via `urls.get`.
const POLL_URL = "https://api.replicate.com/v1/predictions/pred_1";
const IMAGE_URL = "https://replicate.delivery/fake/generated.png";
// PNG magic bytes — proves the provider returns exactly what the image GET served.
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let capturedAuth: string | null = null;
let pollCount = 0;

const server = setupServer(
  http.post(CREATE_URL, ({ request }) => {
    capturedAuth = request.headers.get("authorization");
    return HttpResponse.json({
      id: "pred_1",
      status: "processing",
      output: null,
      urls: { get: POLL_URL, cancel: `${POLL_URL}/cancel` },
    });
  }),
  http.get(POLL_URL, () => {
    pollCount += 1;
    // First poll still running; second poll terminal with the output URL.
    if (pollCount < 2)
      return HttpResponse.json({ id: "pred_1", status: "processing", output: null });
    return HttpResponse.json({ id: "pred_1", status: "succeeded", output: [IMAGE_URL] });
  }),
  http.get(IMAGE_URL, () =>
    HttpResponse.arrayBuffer(PNG_BYTES.buffer, { headers: { "content-type": "image/png" } }),
  ),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
  capturedAuth = null;
  pollCount = 0;
});
afterAll(() => server.close());

function makeProvider(): ReplicateProvider {
  return new ReplicateProvider("rk-test-key", { defaultModel: DEFAULT_REPLICATE_MODEL });
}

describe("ReplicateProvider.generate", () => {
  it("creates, polls to a terminal status, downloads the URL, and echoes metadata", async () => {
    const image = await makeProvider().generate({
      prompt: "a neon cityscape",
      width: 1024,
      height: 768,
      seed: 42,
    });

    expect(image.provider).toBe("replicate");
    expect(image.model).toBe(DEFAULT_REPLICATE_MODEL);
    expect(image.mimeType).toBe("image/png");
    expect(image.seed).toBe(42);
    expect(image.bytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(image.bytes)).toEqual(Array.from(PNG_BYTES));
    // Proves the loop polled through "processing" to the terminal "succeeded".
    expect(pollCount).toBe(2);
  });

  it("sends the auth header as `Bearer <key>`", async () => {
    await makeProvider().generate({ prompt: "a portrait" });
    expect(capturedAuth).toBe("Bearer rk-test-key");
  });

  it("throws an Error whose message cites the HTTP status on a non-2xx create", async () => {
    server.use(http.post(CREATE_URL, () => new HttpResponse("bad request", { status: 400 })));

    await expect(makeProvider().generate({ prompt: "boom" })).rejects.toThrow(/HTTP 400/);
  });

  it("throws citing the prediction error when the status is `failed`", async () => {
    server.use(
      http.get(POLL_URL, () =>
        HttpResponse.json({ id: "pred_1", status: "failed", error: "NSFW content detected" }),
      ),
    );

    await expect(makeProvider().generate({ prompt: "boom" })).rejects.toThrow(
      /NSFW content detected/,
    );
  });
});

describe("resolveImageProvider — replicate branch", () => {
  it("returns a ReplicateProvider when the provider is replicate and the key is set", () => {
    const provider = resolveImageProvider(
      {
        imageGenProvider: "replicate",
        replicateKey: "rk-live",
        falKey: undefined,
        imageGenModel: undefined,
      },
      silentLogger,
    );

    expect(provider).toBeInstanceOf(ReplicateProvider);
    expect(provider?.id).toBe("replicate");
    expect(provider?.defaultModel).toBe(DEFAULT_REPLICATE_MODEL);
  });

  it("returns undefined when the replicate provider is selected but the key is absent", () => {
    const provider = resolveImageProvider(
      {
        imageGenProvider: "replicate",
        replicateKey: undefined,
        falKey: undefined,
        imageGenModel: undefined,
      },
      silentLogger,
    );

    expect(provider).toBeUndefined();
  });
});
