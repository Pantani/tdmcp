import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTdmcpServer } from "../../src/server/tdmcpServer.js";
import { startTransport, type TransportHandle } from "../../src/server/transportFactory.js";
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
});
