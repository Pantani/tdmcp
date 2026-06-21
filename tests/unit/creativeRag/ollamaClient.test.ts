import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { OllamaEmbeddingsClient } from "../../../src/creativeRag/ollamaClient.js";
import {
  OllamaApiError,
  OllamaConnectionError,
  OllamaTimeoutError,
} from "../../../src/creativeRag/ollamaErrors.js";

const OLLAMA_BASE = "http://127.0.0.1:11434";
const EMBED_URL = `${OLLAMA_BASE}/api/embed`;

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function makeClient(timeoutMs = 2000): OllamaEmbeddingsClient {
  return new OllamaEmbeddingsClient({ baseUrl: OLLAMA_BASE, timeoutMs });
}

describe("OllamaEmbeddingsClient.embed", () => {
  it("returns vectors in input order and sends {model, input}", async () => {
    let captured: { model?: string; input?: unknown } = {};
    server.use(
      http.post(EMBED_URL, async ({ request }) => {
        captured = (await request.json()) as { model?: string; input?: unknown };
        return HttpResponse.json({
          model: "nomic-embed-text",
          embeddings: [
            [0.01, -0.02, 0.03],
            [0.1, 0.2, 0.3],
          ],
        });
      }),
    );

    const out = await makeClient().embed(["a", "b"], "nomic-embed-text");

    expect(out).toEqual([
      [0.01, -0.02, 0.03],
      [0.1, 0.2, 0.3],
    ]);
    expect(captured.model).toBe("nomic-embed-text");
    expect(captured.input).toEqual(["a", "b"]);
  });

  it("accepts the legacy single-vector { embedding } shape", async () => {
    server.use(
      http.post(EMBED_URL, () =>
        HttpResponse.json({ model: "nomic-embed-text", embedding: [0.5, 0.6] }),
      ),
    );

    const out = await makeClient().embed(["solo"], "nomic-embed-text");

    expect(out).toEqual([[0.5, 0.6]]);
  });

  it("throws OllamaApiError with status on 404", async () => {
    server.use(http.post(EMBED_URL, () => HttpResponse.text("model not found", { status: 404 })));

    const err = await makeClient()
      .embed(["x"], "nomic-embed-text")
      .catch((e) => e);

    expect(err).toBeInstanceOf(OllamaApiError);
    expect((err as OllamaApiError).status).toBe(404);
    expect((err as OllamaApiError).code).toBe("OLLAMA_API");
    expect((err as Error).message).toContain("ollama pull nomic-embed-text");
    expect((err as Error).message).toContain("model not found");
  });

  it("throws OllamaApiError with status on 500", async () => {
    server.use(http.post(EMBED_URL, () => new HttpResponse(null, { status: 500 })));

    const err = await makeClient()
      .embed(["x"], "nomic-embed-text")
      .catch((e) => e);

    expect(err).toBeInstanceOf(OllamaApiError);
    expect((err as OllamaApiError).status).toBe(500);
  });

  it("throws OllamaConnectionError on a network failure", async () => {
    server.use(http.post(EMBED_URL, () => HttpResponse.error()));

    const err = await makeClient()
      .embed(["x"], "nomic-embed-text")
      .catch((e) => e);

    expect(err).toBeInstanceOf(OllamaConnectionError);
    expect((err as OllamaConnectionError).code).toBe("OLLAMA_CONNECTION");
    expect((err as Error).message).toContain("ollama serve");
    expect((err as Error).message).toContain("ollama pull nomic-embed-text");
  });

  it("throws OllamaApiError on a malformed body", async () => {
    server.use(
      http.post(EMBED_URL, () => HttpResponse.json({ model: "nomic-embed-text", nope: true })),
    );

    const err = await makeClient()
      .embed(["x"], "nomic-embed-text")
      .catch((e) => e);

    expect(err).toBeInstanceOf(OllamaApiError);
  });

  it("throws OllamaTimeoutError when the request never resolves", async () => {
    server.use(
      http.post(EMBED_URL, async () => {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return HttpResponse.json({ model: "nomic-embed-text", embeddings: [[0.1]] });
      }),
    );

    const err = await makeClient(20)
      .embed(["x"], "nomic-embed-text")
      .catch((e) => e);

    expect(err).toBeInstanceOf(OllamaTimeoutError);
    expect((err as OllamaTimeoutError).code).toBe("OLLAMA_TIMEOUT");
  });
});
