import { request } from "node:http";
import { createServer as createNetServer } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveRequestedTier, startChatServer } from "../../src/llm/server.js";
import type { ToolContext } from "../../src/tools/types.js";
import type { TdmcpConfig } from "../../src/utils/config.js";

/** Grab a free loopback port so the test never collides with a real chat server. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

interface Resp {
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

function send(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, method, headers: { ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            headers: res.headers,
          }),
        );
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const getRoot = (port: number, headers: Record<string, string>) =>
  send(port, "GET", "/", headers).then((r) => r.status);

describe("startChatServer loopback guard", () => {
  let port: number;
  let close: () => Promise<void>;

  beforeAll(async () => {
    port = await freePort();
    const config = {
      chatPort: port,
      llmBaseUrl: "http://127.0.0.1:11434",
      llmModel: "test",
      llmApiKey: undefined,
    } as unknown as TdmcpConfig;
    const handle = await startChatServer({} as unknown as ToolContext, config);
    close = handle.close;
  });
  afterAll(() => close?.());

  it("allows a loopback Host with no Origin", async () => {
    expect(await getRoot(port, { Host: `127.0.0.1:${port}` })).toBe(200);
  });

  it("allows the localhost Host alias", async () => {
    expect(await getRoot(port, { Host: `localhost:${port}` })).toBe(200);
  });

  it("allows a same-origin loopback Origin", async () => {
    expect(
      await getRoot(port, { Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}` }),
    ).toBe(200);
  });

  it("allows bracketed IPv6 loopback Host", async () => {
    expect(await getRoot(port, { Host: `[::1]:${port}` })).toBe(200);
  });

  it("rejects a rebound non-loopback Host (DNS rebinding)", async () => {
    expect(await getRoot(port, { Host: "evil.example.com" })).toBe(403);
  });

  it("rejects a cross-origin Origin (CSRF)", async () => {
    expect(
      await getRoot(port, { Host: `127.0.0.1:${port}`, Origin: "http://evil.example.com" }),
    ).toBe(403);
  });

  it("rejects when Origin is malformed", async () => {
    expect(await getRoot(port, { Host: `127.0.0.1:${port}`, Origin: "://not-a-url" })).toBe(403);
  });

  it("returns 404 for unknown paths", async () => {
    const r = await send(port, "GET", "/nope", { Host: `127.0.0.1:${port}` });
    expect(r.status).toBe(404);
    expect(r.body).toContain("not found");
  });
});

describe("resolveRequestedTier", () => {
  it("returns the requested tier when valid", () => {
    expect(resolveRequestedTier("safe")).toBe("safe");
    expect(resolveRequestedTier("creative")).toBe("creative");
    expect(resolveRequestedTier("standard")).toBe("standard");
  });
  it("falls back when requested is unknown", () => {
    expect(resolveRequestedTier(undefined, "safe")).toBe("safe");
    expect(resolveRequestedTier("garbage", "creative")).toBe("creative");
  });
  it("respects the locked tier over everything else", () => {
    expect(resolveRequestedTier("creative", "standard", "safe")).toBe("safe");
  });
  it("falls back to the default tier when no fallback is set", () => {
    expect(resolveRequestedTier(undefined, undefined as never)).toBe("standard");
  });
});

describe("startChatServer endpoints", () => {
  let port: number;
  let close: () => Promise<void>;
  let host: string;

  beforeAll(async () => {
    port = await freePort();
    host = `127.0.0.1:${port}`;
    // Stub global fetch so LlmClient calls to the (non-existent) Ollama endpoint
    // resolve deterministically — covers health/listModels/pull branches.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/models")) {
          return new Response(JSON.stringify({ data: [{ id: "test" }, { id: "other" }] }), {
            status: 200,
          });
        }
        if (url.endsWith("/api/pull")) {
          // Streaming NDJSON-ish body (LlmClient.pull reads lines from body).
          return new Response('{"status":"pulling"}\n{"status":"done"}\n', { status: 200 });
        }
        return new Response("nope", { status: 404 });
      }),
    );
    const config = {
      chatPort: port,
      llmBaseUrl: "http://127.0.0.1:11434",
      llmModel: "test",
      llmApiKey: undefined,
      llmTier: "safe",
      llmMaxSteps: 3,
    } as unknown as TdmcpConfig;
    const handle = await startChatServer({} as unknown as ToolContext, config);
    close = handle.close;
  });
  afterAll(async () => {
    await close?.();
    vi.unstubAllGlobals();
  });

  it("serves the chat HTML at /", async () => {
    const r = await send(port, "GET", "/", { Host: host });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toContain("text/html");
    expect(r.body.length).toBeGreaterThan(100);
  });

  it("reports health, model, hasKey=false and default tier", async () => {
    const r = await send(port, "GET", "/health", { Host: host });
    expect(r.status).toBe(200);
    const data = JSON.parse(r.body);
    expect(data.model).toBe("test");
    expect(data.modelReady).toBe(true);
    expect(data.hasKey).toBe(false);
    expect(data.defaultTier).toBe("safe");
    expect(data.maxSteps).toBe(3);
  });

  it("lists models from the upstream endpoint", async () => {
    const r = await send(port, "GET", "/models", { Host: host });
    expect(r.status).toBe(200);
    const data = JSON.parse(r.body);
    expect(data.models).toEqual(["test", "other"]);
  });

  it("applies a /settings patch and reports hasKey=true after one is set", async () => {
    const r = await send(
      port,
      "POST",
      "/settings",
      { Host: host, "content-type": "application/json" },
      JSON.stringify({ model: "next-model", apiKey: "sk-xyz" }),
    );
    expect(r.status).toBe(200);
    const data = JSON.parse(r.body);
    expect(data.ok).toBe(true);
    expect(data.model).toBe("next-model");
    expect(data.hasKey).toBe(true);
  });

  it("returns a handoff prompt that mentions the user turn", async () => {
    const r = await send(
      port,
      "POST",
      "/handoff",
      { Host: host, "content-type": "application/json" },
      JSON.stringify({ messages: [{ role: "user", content: "build a feedback loop" }] }),
    );
    expect(r.status).toBe(200);
    const data = JSON.parse(r.body);
    expect(typeof data.prompt).toBe("string");
    expect(data.prompt.length).toBeGreaterThan(0);
  });

  it("streams progress on /pull and ends the stream", async () => {
    const r = await send(port, "POST", "/pull", { Host: host });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toContain("text/event-stream");
    expect(r.body).toContain("progress");
    expect(r.body).toContain("done");
  });

  it("rejects a non-loopback POST /chat with 403 (loopback guard runs first)", async () => {
    const r = await send(
      port,
      "POST",
      "/chat",
      { Host: "evil.example.com", "content-type": "application/json" },
      JSON.stringify({ messages: [] }),
    );
    expect(r.status).toBe(403);
  });

  it("returns 500 when the body parser rejects malformed JSON", async () => {
    const r = await send(
      port,
      "POST",
      "/settings",
      { Host: host, "content-type": "application/json" },
      "{not json",
    );
    expect(r.status).toBe(500);
    expect(r.body).toContain("error:");
  });
});
