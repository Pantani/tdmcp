import { request } from "node:http";
import { createServer as createNetServer } from "node:net";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveRequestedTier, startChatServer } from "../../src/llm/server.js";
import type { ToolContext } from "../../src/tools/types.js";
import type { TdmcpConfig } from "../../src/utils/config.js";

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
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers: { Host: `127.0.0.1:${port}`, ...headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const OLLAMA = "http://127.0.0.1:11434";
const mswServer = setupServer(
  http.get(`${OLLAMA}/models`, () =>
    HttpResponse.json({ data: [{ id: "llama3" }, { id: "qwen2" }] }),
  ),
);

describe("resolveRequestedTier", () => {
  it("returns locked when provided", () => {
    expect(resolveRequestedTier("creative", "standard", "safe")).toBe("safe");
  });
  it("accepts explicit safe/standard/creative", () => {
    expect(resolveRequestedTier("safe")).toBe("safe");
    expect(resolveRequestedTier("standard")).toBe("standard");
    expect(resolveRequestedTier("creative")).toBe("creative");
  });
  it("falls back to default when invalid", () => {
    expect(resolveRequestedTier("garbage", "creative")).toBe("creative");
    expect(resolveRequestedTier(undefined, "safe")).toBe("safe");
    expect(resolveRequestedTier(null)).toBe("standard"); // DEFAULT_LLM_TIER
  });
});

describe("startChatServer endpoints", () => {
  let port: number;
  let close: () => Promise<void>;

  beforeAll(async () => {
    mswServer.listen({ onUnhandledRequest: "bypass" });
    port = await freePort();
    const cfg = {
      chatPort: port,
      llmBaseUrl: OLLAMA,
      llmModel: "llama3",
      llmApiKey: undefined,
      llmTier: "safe",
      llmMaxSteps: 5,
      llmTemperature: 0.4,
    } as unknown as TdmcpConfig;
    const handle = await startChatServer({} as unknown as ToolContext, cfg);
    close = handle.close;
  });
  afterAll(async () => {
    await close?.();
    mswServer.close();
  });

  it("GET / returns the chat HTML", async () => {
    const r = await send(port, "GET", "/");
    expect(r.status).toBe(200);
    expect(r.body.length).toBeGreaterThan(100);
  });

  it("GET /health returns status JSON including model/defaultTier/maxSteps", async () => {
    const r = await send(port, "GET", "/health");
    expect(r.status).toBe(200);
    const parsed = JSON.parse(r.body);
    expect(parsed.model).toBe("llama3");
    expect(parsed.defaultTier).toBe("safe");
    expect(parsed.maxSteps).toBe(5);
    expect(parsed.temperature).toBe(0.4);
    expect(parsed.hasKey).toBe(false);
  });

  it("GET /models returns the list from the LLM backend", async () => {
    const r = await send(port, "GET", "/models");
    expect(r.status).toBe(200);
    const parsed = JSON.parse(r.body);
    expect(Array.isArray(parsed.models)).toBe(true);
    expect(parsed.models.length).toBe(2);
  });

  it("POST /settings updates live settings and reflects them in /health", async () => {
    const r = await send(
      port,
      "POST",
      "/settings",
      { "content-type": "application/json" },
      JSON.stringify({ model: "qwen2", apiKey: "k1" }),
    );
    expect(r.status).toBe(200);
    const parsed = JSON.parse(r.body);
    expect(parsed.ok).toBe(true);
    expect(parsed.model).toBe("qwen2");
    expect(parsed.hasKey).toBe(true);

    const h = await send(port, "GET", "/health");
    const hp = JSON.parse(h.body);
    expect(hp.model).toBe("qwen2");
    expect(hp.hasKey).toBe(true);
  });

  it("POST /handoff returns a generated prompt", async () => {
    const r = await send(
      port,
      "POST",
      "/handoff",
      { "content-type": "application/json" },
      JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    );
    expect(r.status).toBe(200);
    const parsed = JSON.parse(r.body);
    expect(typeof parsed.prompt).toBe("string");
    expect(parsed.prompt.length).toBeGreaterThan(0);
  });

  it("unknown path returns 404", async () => {
    const r = await send(port, "GET", "/nope");
    expect(r.status).toBe(404);
  });

  it("POST with invalid JSON body returns 500 error text", async () => {
    const r = await send(
      port,
      "POST",
      "/handoff",
      { "content-type": "application/json" },
      "{not json",
    );
    expect(r.status).toBe(500);
    expect(r.body).toContain("error");
  });
});
