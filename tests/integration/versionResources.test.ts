import { afterEach, describe, expect, it } from "vitest";
import { closeSessions, connectClient, jsonText, type ResourceClientSession } from "./helpers.js";

const sessions: ResourceClientSession[] = [];

async function connectResourceClient() {
  const session = await connectClient("tdmcp-version-resource-test");
  sessions.push(session);
  return session.client;
}

afterEach(async () => {
  await closeSessions(sessions);
});

describe("integration: TouchDesigner version resources", () => {
  it("reads stable TouchDesigner release metadata as an MCP resource", async () => {
    const client = await connectResourceClient();

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
    const client = await connectResourceClient();

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

  it("returns JSON errors for malformed version resource URIs", async () => {
    const client = await connectResourceClient();

    const versionResult = await client.readResource({ uri: "tdmcp://td-versions/%E0%A4%A" });
    const experimentalResult = await client.readResource({
      uri: "tdmcp://td-experimental/%E0%A4%A",
    });

    expect(JSON.parse(jsonText(versionResult))).toEqual(
      expect.objectContaining({ error: expect.stringContaining("%E0%A4%A") }),
    );
    expect(JSON.parse(jsonText(experimentalResult))).toEqual(
      expect.objectContaining({ error: expect.stringContaining("%E0%A4%A") }),
    );
  });
});
