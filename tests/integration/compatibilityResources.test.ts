import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createTdmcpServer } from "../../src/server/tdmcpServer.js";
import { loadConfig } from "../../src/utils/config.js";
import { silentLogger } from "../../src/utils/logger.js";

async function connectClient() {
  const config = loadConfig();
  const server = createTdmcpServer(config, { logger: silentLogger });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "tdmcp-compatibility-resource-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

type ResourceReadResult = Awaited<ReturnType<Client["readResource"]>>;

function jsonText(result: ResourceReadResult): string {
  const content = result.contents[0];
  expect(content?.mimeType).toBe("application/json");
  if (!content || !("text" in content)) {
    throw new Error("Expected JSON text resource content.");
  }
  return content.text;
}

describe("integration: compatibility resources", () => {
  it("reads operator compatibility as an MCP resource", async () => {
    const client = await connectClient();

    const result = await client.readResource({
      uri: "tdmcp://compat/operators/noise_top",
    });
    const payload = JSON.parse(jsonText(result)) as {
      name: string;
      addedIn?: string;
      changedIn?: Array<{ version: string }>;
    };

    expect(payload.name).toBe("Noise TOP");
    expect(payload.addedIn).toBe("099");
    expect(payload.changedIn?.length).toBeGreaterThan(0);
  });

  it("reads Python API compatibility as an MCP resource", async () => {
    const client = await connectClient();

    const result = await client.readResource({
      uri: "tdmcp://compat/python/OP.cook",
    });
    const payload = JSON.parse(jsonText(result)) as {
      class: string;
      name: string;
      kind: string;
      addedIn?: string;
    };

    expect(payload).toMatchObject({ class: "OP", name: "cook", kind: "method" });
    expect(payload.addedIn).toBe("099");
  });
});
