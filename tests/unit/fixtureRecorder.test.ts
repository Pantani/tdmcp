/**
 * Offline unit tests for fixtureRecorder — no live TouchDesigner, no MCP server boot.
 * Tests the pure functional core: wrapRecordingFetch, FixtureWriter, mountFixture.
 */

import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type FixtureFile,
  FixtureWriter,
  mountFixture,
  type RecordingFilters,
  wrapRecordingFetch,
} from "../../src/cli/fixtureRecorder.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";

const TD_BASE = "http://127.0.0.1:9980";

// ---------------------------------------------------------------------------
// Shared msw server
// ---------------------------------------------------------------------------
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const okInfo = { td_version: "099", bridge_version: "1.0.0" };
const okNodeRef = { path: "/project1/amp", type: "constantCHOP", name: "amp" };

function makeHandlers() {
  return [
    http.get(`${TD_BASE}/api/info`, () => HttpResponse.json({ ok: true, data: okInfo })),
    http.post(`${TD_BASE}/api/nodes`, () => HttpResponse.json({ ok: true, data: okNodeRef })),
  ];
}

function makeWriter(base = TD_BASE): FixtureWriter {
  return new FixtureWriter(base);
}

function makeFilters(over: Partial<RecordingFilters> = {}): RecordingFilters {
  return { include: ["*"], exclude: [], max: 500, redactBody: false, ...over };
}

function makeClient(fetchImpl: typeof fetch): TouchDesignerClient {
  return new TouchDesignerClient({ baseUrl: TD_BASE, fetchImpl });
}

// ---------------------------------------------------------------------------
// 1. wrapFetch records GET + POST pairs
// ---------------------------------------------------------------------------
describe("wrapRecordingFetch — records GET and POST", () => {
  it("captures two entries with correct method and url", async () => {
    server.use(...makeHandlers());
    const writer = makeWriter();
    const wrapped = wrapRecordingFetch(fetch, writer, makeFilters());
    const client = makeClient(wrapped);

    await client.getInfo();
    await client.createNode({ parent_path: "/project1", type: "constantCHOP", name: "amp" });

    expect(writer.entries).toHaveLength(2);
    const [get, post] = writer.entries;
    expect(get?.method).toBe("GET");
    expect(get?.url).toBe("/api/info");
    expect(post?.method).toBe("POST");
    expect(post?.url).toBe("/api/nodes");
    expect((post?.response.body as { data: unknown })?.data).toMatchObject(okNodeRef);
    expect(get?.id).toBe(1);
    expect(post?.id).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 2. --include filter only captures matching paths
// ---------------------------------------------------------------------------
describe("wrapRecordingFetch — include filter", () => {
  it("records only /api/nodes when include=[/api/nodes]", async () => {
    server.use(...makeHandlers());
    const writer = makeWriter();
    const wrapped = wrapRecordingFetch(fetch, writer, makeFilters({ include: ["/api/nodes"] }));
    const client = makeClient(wrapped);

    await client.getInfo();
    await client.createNode({ parent_path: "/project1", type: "constantCHOP", name: "amp" });

    expect(writer.entries).toHaveLength(1);
    expect(writer.entries[0]?.method).toBe("POST");
    expect(writer.entries[0]?.url).toBe("/api/nodes");
  });
});

// ---------------------------------------------------------------------------
// 3. --exclude wins over include
// ---------------------------------------------------------------------------
describe("wrapRecordingFetch — exclude overrides include", () => {
  it("skips /api/info when exclude=[/api/info]", async () => {
    server.use(...makeHandlers());
    const writer = makeWriter();
    const wrapped = wrapRecordingFetch(
      fetch,
      writer,
      makeFilters({ include: ["*"], exclude: ["/api/info"] }),
    );
    const client = makeClient(wrapped);

    await client.getInfo();
    await client.createNode({ parent_path: "/project1", type: "constantCHOP", name: "amp" });

    expect(writer.entries).toHaveLength(1);
    expect(writer.entries[0]?.method).toBe("POST");
  });
});

// ---------------------------------------------------------------------------
// 4. Token redaction
// ---------------------------------------------------------------------------
describe("wrapRecordingFetch — token redaction", () => {
  it("redacts Authorization header to Bearer ***", async () => {
    server.use(
      http.get(`${TD_BASE}/api/info`, () => HttpResponse.json({ ok: true, data: okInfo })),
    );
    const writer = makeWriter();
    const wrapped = wrapRecordingFetch(fetch, writer, makeFilters({ redactBody: true }));
    // Client sends Authorization: Bearer secret123
    const client = new TouchDesignerClient({
      baseUrl: TD_BASE,
      token: "secret123",
      fetchImpl: wrapped,
    });

    await client.getInfo();

    expect(writer.entries).toHaveLength(1);
    const authHeader = writer.entries[0]?.request.headers.authorization;
    expect(authHeader).toBe("Bearer ***");
  });
});

// ---------------------------------------------------------------------------
// 5. Body size cap
// ---------------------------------------------------------------------------
describe("wrapRecordingFetch — body size cap", () => {
  it("truncates large request bodies and reports size", async () => {
    // Construct a >256KB JSON body via executePythonScript
    const bigBody = JSON.stringify({ script: `x${"a".repeat(300 * 1024)}` });
    server.use(
      http.post(`${TD_BASE}/api/exec`, () => HttpResponse.json({ ok: true, data: { stdout: "" } })),
    );
    const writer = makeWriter();
    const wrapped = wrapRecordingFetch(fetch, writer, makeFilters());
    // Call fetch directly to control request body
    await wrapped(`${TD_BASE}/api/exec`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: bigBody,
    });

    expect(writer.entries).toHaveLength(1);
    const reqBody = writer.entries[0]?.request.body as { truncated: boolean; size: number };
    expect(reqBody.truncated).toBe(true);
    expect(reqBody.size).toBeGreaterThan(256 * 1024);
  });
});

// ---------------------------------------------------------------------------
// 6. --max stops recording (calls still execute)
// ---------------------------------------------------------------------------
describe("wrapRecordingFetch — max cap", () => {
  it("records at most max=2 entries even when more requests are made", async () => {
    server.use(...makeHandlers());
    const writer = makeWriter();
    const wrapped = wrapRecordingFetch(fetch, writer, makeFilters({ max: 2 }));
    const client = makeClient(wrapped);

    // 4 requests: getInfo x2, createNode x2
    await client.getInfo();
    await client.getInfo();
    await client.createNode({ parent_path: "/project1", type: "constantCHOP", name: "amp" });
    await client.createNode({ parent_path: "/project1", type: "constantCHOP", name: "amp2" });

    expect(writer.entries).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 7. finalize writes valid JSON to disk
// ---------------------------------------------------------------------------
describe("FixtureWriter.finalize", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `fixture-recorder-test-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("writes parseable JSON with version 1 and entries array", async () => {
    server.use(...makeHandlers());
    const writer = makeWriter();
    const wrapped = wrapRecordingFetch(fetch, writer, makeFilters());
    const client = makeClient(wrapped);

    await client.getInfo();
    await client.createNode({ parent_path: "/project1", type: "constantCHOP", name: "amp" });

    const outPath = join(tmpDir, "test-fixture.json");
    await writer.finalize(outPath, true);

    const raw = await readFile(outPath, "utf8");
    const parsed = JSON.parse(raw) as FixtureFile;
    expect(parsed.version).toBe(1);
    expect(typeof parsed.recordedAt).toBe("string");
    expect(parsed.baseUrl).toBe(TD_BASE);
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[0]?.method).toBe("GET");
    expect(parsed.entries[1]?.method).toBe("POST");
  });
});

// ---------------------------------------------------------------------------
// 8. Fixture round-trip — recorded fixture is replayable via mountFixture
// ---------------------------------------------------------------------------
describe("mountFixture round-trip", () => {
  it("replays recorded responses identically through a fresh msw server", async () => {
    // Step 1: record
    server.use(...makeHandlers());
    const writer = makeWriter();
    const wrapped = wrapRecordingFetch(fetch, writer, makeFilters());
    const clientA = makeClient(wrapped);
    await clientA.getInfo();
    await clientA.createNode({ parent_path: "/project1", type: "constantCHOP", name: "amp" });

    const fixture: FixtureFile = {
      version: 1,
      recordedAt: new Date().toISOString(),
      baseUrl: TD_BASE,
      entries: writer.entries,
    };

    // Step 2: reset msw (no manual handlers) and mount from fixture
    server.resetHandlers();
    mountFixture(
      server,
      fixture,
      {
        get: (url: string, handler: () => unknown) =>
          http.get(url, handler as Parameters<typeof http.get>[1]),
        post: (url: string, handler: () => unknown) =>
          http.post(url, handler as Parameters<typeof http.post>[1]),
        patch: (url: string, handler: () => unknown) =>
          http.patch(url, handler as Parameters<typeof http.patch>[1]),
        delete: (url: string, handler: () => unknown) =>
          http.delete(url, handler as Parameters<typeof http.delete>[1]),
      },
      (body: unknown, init?: { status?: number }) =>
        HttpResponse.json(body as Parameters<typeof HttpResponse.json>[0], init),
    );

    // Step 3: fresh client — should get back the recorded responses
    const clientB = makeClient(fetch);
    const info = await clientB.getInfo();
    expect(info).toMatchObject(okInfo);

    const node = await clientB.createNode({
      parent_path: "/project1",
      type: "constantCHOP",
      name: "amp",
    });
    expect(node).toMatchObject(okNodeRef);
  });
});
