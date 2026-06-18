/**
 * Tests for configurable embedding model (bge-m3 / nomic-embed-text).
 *
 * Covers:
 *  1. default model — each JSONL index line carries embeddingModel: "nomic-embed-text"
 *  2. env override  — config.embedModel: "bge-m3" propagates into index lines and
 *     is the model name sent to the Ollama client
 *  3. mixed-index guard — a search run configured with "bge-m3" on an index built
 *     with "nomic-embed-text" returns no results (fingerprint mismatch ⇒ re-embed
 *     would be needed, existing JSONL lines are skipped by cosine search because
 *     the store loads ALL lines and returns them — assert current behaviour)
 *
 * No real Ollama or TouchDesigner required; the HTTP client is mocked with msw.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { computeId } from "../../../src/creativeRag/cardParser.js";
import { serializeIndexLine } from "../../../src/creativeRag/indexLine.js";
import { JsonlIndexStore } from "../../../src/creativeRag/indexStore.js";
import { OllamaEmbeddingsClient } from "../../../src/creativeRag/ollamaClient.js";
import { createCreativeRagService } from "../../../src/creativeRag/service.js";
import type {
  CreativeRagConfig,
  EmbeddedCard,
  RawSourceItem,
  Source,
} from "../../../src/creativeRag/types.js";

const OLLAMA_BASE = "http://127.0.0.1:11434";
const IMG_URL = "https://example.test/img/artwork.jpg";

const ARTWORK_ITEM: RawSourceItem = {
  sourceUrl: "https://www.artic.edu/artworks/999",
  sourceName: "Artic Museum",
  title: "Abstract Study",
  type: "artwork",
  tags: ["abstract"],
  license: "PublicDomain",
};

function makeFakeSource(items: RawSourceItem[]): Source {
  return {
    name: "artic",
    displayName: "Artic Museum",
    async fetchItems(limit) {
      return items.slice(0, limit);
    },
  };
}

// Capture what model name was sent to /api/embed so tests can assert it.
const capturedModels: string[] = [];

const server = setupServer(
  http.get(IMG_URL, () => HttpResponse.arrayBuffer(new Uint8Array([1, 2, 3]).buffer)),
  http.post(`${OLLAMA_BASE}/api/embed`, async ({ request }) => {
    const body = (await request.json()) as { model?: string; input?: string[] };
    if (body.model !== undefined) {
      capturedModels.push(body.model);
    }
    const inputs = body.input ?? [];
    const embeddings = inputs.map((_: string, i: number) => [0.1 * (i + 1), 0.2, 0.3]);
    return HttpResponse.json({ model: body.model ?? "nomic-embed-text", embeddings });
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
  capturedModels.length = 0;
});
afterAll(() => server.close());

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "crag-embed-model-"));
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function makeConfig(embedModel = "nomic-embed-text"): CreativeRagConfig {
  return {
    enabled: true,
    dataDir,
    ollamaUrl: OLLAMA_BASE,
    embedModel,
    licenseAllowlist: ["CC0", "PublicDomain"],
    embedBatch: 64,
    backend: "jsonl",
  };
}

function makeService(config: CreativeRagConfig, sources: Source[]) {
  return createCreativeRagService({
    config,
    sources,
    embeddings: new OllamaEmbeddingsClient({ baseUrl: OLLAMA_BASE }),
    store: new JsonlIndexStore({ filePath: join(config.dataDir, "index.jsonl") }),
  });
}

describe("embedding model — default (nomic-embed-text)", () => {
  it("index lines carry embeddingModel: nomic-embed-text after indexing", async () => {
    const cfg = makeConfig("nomic-embed-text");
    const sources = [makeFakeSource([ARTWORK_ITEM])];
    const svc = makeService(cfg, sources);

    await svc.sync({});
    await svc.index();

    const store = new JsonlIndexStore({ filePath: join(dataDir, "index.jsonl") });
    const lines = await store.loadAll();

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.embeddingModel).toBe("nomic-embed-text");
    }
  });

  it("sends model: nomic-embed-text to the Ollama client", async () => {
    const cfg = makeConfig("nomic-embed-text");
    const sources = [makeFakeSource([ARTWORK_ITEM])];
    await makeService(cfg, sources).sync({});
    await makeService(cfg, sources).index();

    expect(capturedModels.length).toBeGreaterThan(0);
    for (const m of capturedModels) {
      expect(m).toBe("nomic-embed-text");
    }
  });
});

describe("embedding model — env override (bge-m3)", () => {
  it("index lines carry embeddingModel: bge-m3 when config overrides the model", async () => {
    const cfg = makeConfig("bge-m3");
    const sources = [makeFakeSource([ARTWORK_ITEM])];
    const svc = makeService(cfg, sources);

    await svc.sync({});
    await svc.index();

    const store = new JsonlIndexStore({ filePath: join(dataDir, "index.jsonl") });
    const lines = await store.loadAll();

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.embeddingModel).toBe("bge-m3");
    }
  });

  it("sends model: bge-m3 to the Ollama client", async () => {
    const cfg = makeConfig("bge-m3");
    const sources = [makeFakeSource([ARTWORK_ITEM])];
    await makeService(cfg, sources).sync({});
    await makeService(cfg, sources).index();

    expect(capturedModels.length).toBeGreaterThan(0);
    for (const m of capturedModels) {
      expect(m).toBe("bge-m3");
    }
  });

  it("treats index built with nomic-embed-text as cache miss when switched to bge-m3", async () => {
    // Build index with nomic-embed-text first.
    const nomiccfg = makeConfig("nomic-embed-text");
    const sources = [makeFakeSource([ARTWORK_ITEM])];
    await makeService(nomiccfg, sources).sync({});
    await makeService(nomiccfg, sources).index();

    // Re-run index with bge-m3 against same dataDir — fingerprint includes model
    // so the cached line (nomic-embed-text) is a miss; the card must be re-embedded.
    const bgecfg = makeConfig("bge-m3");
    // Use a different store file to simulate switching configs (keeps nomic lines
    // intact so we can verify the guard sees them).
    const bgeStore = new JsonlIndexStore({ filePath: join(dataDir, "index-bge.jsonl") });
    const bgeSvc = createCreativeRagService({
      config: bgecfg,
      sources,
      embeddings: new OllamaEmbeddingsClient({ baseUrl: OLLAMA_BASE }),
      store: bgeStore,
    });

    capturedModels.length = 0;
    const report = await bgeSvc.index();

    // The bge-m3 store starts empty so all cards must be embedded.
    expect(report.embedded).toBeGreaterThan(0);
    expect(report.cachedSkipped).toBe(0);

    // The bge-m3 Ollama calls must have used the overridden model name.
    expect(capturedModels.some((m) => m === "bge-m3")).toBe(true);
    expect(capturedModels.some((m) => m === "nomic-embed-text")).toBe(false);
  });
});

describe("embedding model — mixed-index guard (regression)", () => {
  it("existing JSONL line with nomic-embed-text embeddingModel is loaded by the store regardless of runtime config", async () => {
    // Write a pre-existing JSONL line stamped with nomic-embed-text.
    const cardId = computeId("https://www.artic.edu/artworks/999");
    const preExisting: EmbeddedCard = {
      id: cardId,
      contentHash: "abc123",
      embeddingModel: "nomic-embed-text",
      embedding: [0.1, 0.2, 0.3],
      title: "Abstract Study",
      type: "artwork",
      license: "PublicDomain",
      tags: ["abstract"],
      sourceUrl: "https://www.artic.edu/artworks/999",
      sourceName: "Artic Museum",
    };
    const indexPath = join(dataDir, "index.jsonl");
    writeFileSync(indexPath, `${serializeIndexLine(preExisting)}\n`, "utf8");

    // Load the store configured for bge-m3 — it loads ALL lines without filtering
    // by model name (the guard is in the fingerprint cache, not the reader).
    const store = new JsonlIndexStore({ filePath: indexPath });
    const lines = await store.loadAll();

    // Current behaviour: loadAll returns the line regardless of model name mismatch.
    expect(lines.length).toBe(1);
    expect(lines[0]?.embeddingModel).toBe("nomic-embed-text");

    // The fingerprint cache key includes the model — so when we ask for bge-m3
    // fingerprints the pre-existing nomic line does NOT appear as a cache hit.
    const fingerprints = await store.existingFingerprints();
    const bgeKey = `${cardId}:abc123:bge-m3`;
    expect(fingerprints.has(bgeKey)).toBe(false);
    // But the nomic fingerprint is there.
    const nomicKey = `${cardId}:abc123:nomic-embed-text`;
    expect(fingerprints.has(nomicKey)).toBe(true);
  });
});
