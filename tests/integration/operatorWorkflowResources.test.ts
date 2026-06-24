import { afterEach, describe, expect, it } from "vitest";
import { closeSessions, connectClient, jsonText, type ResourceClientSession } from "./helpers.js";

const sessions: ResourceClientSession[] = [];

async function connectResourceClient() {
  const session = await connectClient("tdmcp-operator-workflow-resource-test");
  sessions.push(session);
  return session.client;
}

afterEach(async () => {
  await closeSessions(sessions);
});

describe("integration: operator workflow resources", () => {
  it("reads operator connection guidance as an MCP resource", async () => {
    const client = await connectResourceClient();

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
    const client = await connectResourceClient();

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

  it("returns JSON errors for malformed operator workflow resource URIs", async () => {
    const client = await connectResourceClient();

    const connectionResult = await client.readResource({
      uri: "tdmcp://operator-connections/%E0%A4%A",
    });
    const exampleResult = await client.readResource({
      uri: "tdmcp://operator-examples/%E0%A4%A",
    });

    expect(JSON.parse(jsonText(connectionResult))).toEqual(
      expect.objectContaining({ error: expect.stringContaining("%E0%A4%A") }),
    );
    expect(JSON.parse(jsonText(exampleResult))).toEqual(
      expect.objectContaining({ error: expect.stringContaining("%E0%A4%A") }),
    );
  });
});
