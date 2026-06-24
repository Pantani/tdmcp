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
  const client = new Client({ name: "tdmcp-technique-class-resource-test", version: "0.0.0" });
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

describe("integration: technique pack and TD class resources", () => {
  it("reads Bottobot technique packs as MCP resources", async () => {
    const client = await connectClient();

    const result = await client.readResource({
      uri: "tdmcp://techniques/audio-visual",
    });
    const payload = JSON.parse(jsonText(result)) as {
      category: string;
      displayName: string;
      techniques: Array<{ id: string; operators?: string[] }>;
    };

    expect(payload.category).toBe("audio-visual");
    expect(payload.displayName).toBe("Audio-Visual");
    expect(payload.techniques.length).toBeGreaterThan(0);
    expect(payload.techniques[0]?.operators?.length).toBeGreaterThan(0);
  });

  it("reads TouchDesigner class family references as MCP resources", async () => {
    const client = await connectClient();

    const result = await client.readResource({
      uri: "tdmcp://td-classes/top_class",
    });
    const payload = JSON.parse(jsonText(result)) as {
      id: string;
      displayName?: string;
      description?: string;
    };

    expect(payload.id).toBe("top_class");
    expect(payload.displayName).toBe("TOP Class");
    expect(payload.description).toContain("TOP operator");
  });
});
