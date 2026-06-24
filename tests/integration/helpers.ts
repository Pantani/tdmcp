import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect } from "vitest";
import { createTdmcpServer } from "../../src/server/tdmcpServer.js";
import { loadConfig } from "../../src/utils/config.js";
import { silentLogger } from "../../src/utils/logger.js";

type ResourceReadResult = Awaited<ReturnType<Client["readResource"]>>;

export interface ResourceClientSession {
  client: Client;
  close: () => Promise<void>;
}

export async function connectClient(clientName: string): Promise<ResourceClientSession> {
  const config = loadConfig();
  const server = createTdmcpServer(config, { logger: silentLogger });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: clientName, version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    close: async () => {
      await Promise.all([client.close(), server.close()]);
    },
  };
}

export async function closeSessions(sessions: ResourceClientSession[]): Promise<void> {
  const active = sessions.splice(0);
  await Promise.all(active.map((session) => session.close()));
}

export function jsonText(result: ResourceReadResult): string {
  const content = result.contents[0];
  expect(content?.mimeType).toBe("application/json");
  if (!content || !("text" in content)) {
    throw new Error("Expected JSON text resource content.");
  }
  return content.text;
}
