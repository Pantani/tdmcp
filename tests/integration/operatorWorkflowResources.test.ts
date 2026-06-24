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
  const client = new Client({ name: "tdmcp-operator-workflow-resource-test", version: "0.0.0" });
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

describe("integration: operator workflow resources", () => {
  it("reads operator connection guidance as an MCP resource", async () => {
    const client = await connectClient();

    const result = await client.readResource({
      uri: "tdmcp://operator-connections/Feedback%20TOP",
    });
    const payload = JSON.parse(jsonText(result)) as {
      operator: { name: string; category: string };
      outputs: Array<{ op: string }>;
      workflowHits: Array<{ patternId: string }>;
    };

    expect(payload.operator).toMatchObject({ name: "Feedback TOP", category: "TOP" });
    expect(payload.outputs.map((entry) => entry.op)).toContain("Null TOP");
    expect(payload.workflowHits.length).toBeGreaterThan(0);
  });

  it("reads operator examples as an MCP resource", async () => {
    const client = await connectClient();

    const result = await client.readResource({
      uri: "tdmcp://operator-examples/Movie%20File%20In%20TOP",
    });
    const payload = JSON.parse(jsonText(result)) as {
      operator: { name: string; category: string };
      pythonExamples: unknown[];
      usagePatterns: Array<{ title: string; code: string }>;
      tips: string[];
    };

    expect(payload.operator).toMatchObject({ name: "Movie File In TOP", category: "TOP" });
    expect(payload.pythonExamples.length).toBeGreaterThan(0);
    expect(payload.usagePatterns.some((entry) => entry.title.includes("Create"))).toBe(true);
    expect(payload.tips.length).toBeGreaterThan(0);
  });
});
