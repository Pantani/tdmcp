import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createTdmcpServer } from "../../src/server/tdmcpServer.js";
import { loadConfig } from "../../src/utils/config.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer } from "../helpers/tdMock.js";

const mock = makeTdServer();
beforeAll(() => mock.listen({ onUnhandledRequest: "error" }));
afterEach(() => mock.resetHandlers());
afterAll(() => mock.close());

async function connectClient() {
  const config = loadConfig({}); // defaults → 127.0.0.1:9980 (matches the mock bridge)
  const server = createTdmcpServer(config, { logger: silentLogger });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "tdmcp-test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("integration: Layer 3 over the MCP protocol", () => {
  it("exposes all 9 Layer 3 tools", async () => {
    const client = await connectClient();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "get_td_info",
        "create_td_node",
        "delete_td_node",
        "update_td_node_parameters",
        "get_td_nodes",
        "get_td_node_parameters",
        "get_td_node_errors",
        "execute_python_script",
        "exec_node_method",
      ]),
    );
  });

  it("creates a Noise TOP, then a Null TOP, then lists them", async () => {
    const client = await connectClient();
    const noise = await client.callTool({
      name: "create_td_node",
      arguments: { parent_path: "/project1", type: "noiseTOP", name: "noise1" },
    });
    expect(JSON.stringify(noise.content)).toContain("/project1/noise1");

    const nullTop = await client.callTool({
      name: "create_td_node",
      arguments: { parent_path: "/project1", type: "nullTOP", name: "null1" },
    });
    expect(JSON.stringify(nullTop.content)).toContain("/project1/null1");

    const list = await client.callTool({
      name: "get_td_nodes",
      arguments: { parent_path: "/project1", detail_level: "full" },
    });
    // Node data now travels on the structuredContent channel, not the text block.
    const data = JSON.stringify(list.structuredContent);
    expect(data).toContain("noise1");
    expect(data).toContain("null1");
  });

  it("reads the operator knowledge resource", async () => {
    const client = await connectClient();
    const result = await client.readResource({ uri: "tdmcp://operators/TOP" });
    expect(result.contents.length).toBeGreaterThan(0);
    expect(JSON.stringify(result.contents)).toContain("Noise TOP");
  });

  it("get_td_info returns bridge info through MCP when mocked", async () => {
    const client = await connectClient();
    const result = await client.callTool({ name: "get_td_info", arguments: {} });
    expect(JSON.stringify(result.content)).toContain("2023.12000");
  });
});
