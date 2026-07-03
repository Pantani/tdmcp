import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTdmcpServer } from "../../src/server/tdmcpServer.js";
import {
  isCrossOriginRejected,
  isUnsupportedPostMediaType,
  startTransport,
  type TransportHandle,
} from "../../src/server/transportFactory.js";
import { loadConfig } from "../../src/utils/config.js";
import { silentLogger } from "../../src/utils/logger.js";

const PORT = 39411;
let handle: TransportHandle;

beforeAll(async () => {
  const config = loadConfig({ TDMCP_TRANSPORT: "http", TDMCP_HTTP_PORT: String(PORT) });
  handle = await startTransport(
    () => createTdmcpServer(config, { logger: silentLogger }),
    config,
    silentLogger,
  );
});

afterAll(async () => {
  await handle.close();
});

describe("integration: Streamable HTTP transport", () => {
  it("serves MCP over HTTP and lists tools", async () => {
    const client = new Client({ name: "tdmcp-http-test", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`));
    await client.connect(transport);

    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThanOrEqual(31);
    expect(tools.map((t) => t.name)).toContain("get_td_info");

    await client.close();
  });

  it("rejects a non-initialize POST without a session", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 for paths other than /mcp", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/not-mcp`);
    expect(res.status).toBe(404);
  });

  it("rejects a GET without a session id", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/mcp`, { method: "GET" });
    expect(res.status).toBe(400);
  });

  it("rejects a request bearing a non-loopback Origin with 403", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://evil.example.com",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(403);
  });

  it("allows a loopback Origin", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: `http://127.0.0.1:${PORT}`,
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    // Not 403: passes the Origin gate (400 = no session, which is the expected next step).
    expect(res.status).not.toBe(403);
  });

  it("rejects a POST with a non-JSON Content-Type with 415", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "not json",
    });
    expect(res.status).toBe(415);
  });
});

describe("HTTP transport guards (unit)", () => {
  it("isCrossOriginRejected: only non-loopback origins are rejected", () => {
    expect(isCrossOriginRejected(undefined)).toBe(false);
    expect(isCrossOriginRejected("http://127.0.0.1:39411")).toBe(false);
    expect(isCrossOriginRejected("http://localhost")).toBe(false);
    expect(isCrossOriginRejected("http://evil.example.com")).toBe(true);
    expect(isCrossOriginRejected("garbage")).toBe(true);
  });

  it("isUnsupportedPostMediaType: only non-JSON POST bodies are rejected", () => {
    expect(isUnsupportedPostMediaType("POST", "application/json")).toBe(false);
    expect(isUnsupportedPostMediaType("POST", "application/json; charset=utf-8")).toBe(false);
    expect(isUnsupportedPostMediaType("POST", "text/plain")).toBe(true);
    expect(isUnsupportedPostMediaType("POST", undefined)).toBe(false);
    expect(isUnsupportedPostMediaType("GET", "text/plain")).toBe(false);
  });
});
