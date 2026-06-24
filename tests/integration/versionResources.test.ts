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
  const client = new Client({ name: "tdmcp-version-resource-test", version: "0.0.0" });
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

describe("integration: TouchDesigner version resources", () => {
  it("reads stable TouchDesigner release metadata as an MCP resource", async () => {
    const client = await connectClient();

    const result = await client.readResource({ uri: "tdmcp://td-versions/2023" });
    const payload = JSON.parse(jsonText(result)) as {
      version: { id: string; pythonMajorMinor?: string };
      releaseHighlights: { highlights: unknown[] };
      operatorChanges: unknown[];
    };
    expect(payload.version.id).toBe("2023");
    expect(payload.version.pythonMajorMinor).toBe("3.11");
    expect(payload.releaseHighlights.highlights.length).toBeGreaterThan(0);
    expect(payload.operatorChanges.length).toBeGreaterThan(0);
  });

  it("reads experimental build metadata as an MCP resource", async () => {
    const client = await connectClient();

    const result = await client.readResource({
      uri: "tdmcp://td-experimental/2025.10000",
    });
    const payload = JSON.parse(jsonText(result)) as {
      seriesId: string;
      experimentalOperators: unknown[];
    };
    expect(payload.seriesId).toBe("2025.10000");
    expect(payload.experimentalOperators.length).toBeGreaterThan(0);
  });
});
