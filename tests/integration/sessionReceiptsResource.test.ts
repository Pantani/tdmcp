import { afterEach, describe, expect, it } from "vitest";
import { closeSessions, connectClient, jsonText, type ResourceClientSession } from "./helpers.js";

const sessions: ResourceClientSession[] = [];

afterEach(async () => {
  await closeSessions(sessions);
});

async function resourceClient() {
  const session = await connectClient("tdmcp-session-receipts-resource-test");
  sessions.push(session);
  return session.client;
}

describe("integration: session receipts resource", () => {
  it.each([
    "tdmcp://session/receipts",
    "tdmcp://session/receipts?limit=5",
    "tdmcp://session/receipts?status=success",
    "tdmcp://session/receipts?limit=5&status=success",
    "tdmcp://session/receipts?status=success&limit=5",
  ])("reads %s through MCP resources/read", async (uri) => {
    const client = await resourceClient();
    const result = await client.readResource({ uri });
    const payload = JSON.parse(jsonText(result)) as { state: string; filters: { limit: number } };
    expect(payload.state).toBe("off");
    expect(payload.filters.limit).toBe(uri.includes("limit=5") ? 5 : 20);
  });
});
