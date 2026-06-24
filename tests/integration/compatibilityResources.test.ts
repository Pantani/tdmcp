import { afterEach, describe, expect, it } from "vitest";
import { closeSessions, connectClient, jsonText, type ResourceClientSession } from "./helpers.js";

const sessions: ResourceClientSession[] = [];

async function connectResourceClient() {
  const session = await connectClient("tdmcp-compatibility-resource-test");
  sessions.push(session);
  return session.client;
}

afterEach(async () => {
  await closeSessions(sessions);
});

describe("integration: compatibility resources", () => {
  it("reads operator compatibility as an MCP resource", async () => {
    const client = await connectResourceClient();

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
    const client = await connectResourceClient();

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
