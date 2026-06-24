import { afterEach, describe, expect, it } from "vitest";
import { closeSessions, connectClient, jsonText, type ResourceClientSession } from "./helpers.js";

const sessions: ResourceClientSession[] = [];

async function connectResourceClient() {
  const session = await connectClient("tdmcp-technique-class-resource-test");
  sessions.push(session);
  return session.client;
}

afterEach(async () => {
  await closeSessions(sessions);
});

describe("integration: technique pack and TD class resources", () => {
  it("reads Bottobot technique packs as MCP resources", async () => {
    const client = await connectResourceClient();

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
    const client = await connectResourceClient();

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

  it("returns a JSON error for malformed technique pack resource URIs", async () => {
    const client = await connectResourceClient();

    const result = await client.readResource({
      uri: "tdmcp://techniques/%E0%A4%A",
    });
    const payload = JSON.parse(jsonText(result)) as { error: string };

    expect(payload.error).toContain("%E0%A4%A");
  });
});
