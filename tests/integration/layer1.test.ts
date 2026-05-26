import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createTdmcpServer } from "../../src/server/tdmcpServer.js";
import { loadConfig } from "../../src/utils/config.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer } from "../helpers/tdMock.js";

const mock = makeTdServer();
beforeAll(() => mock.listen({ onUnhandledRequest: "error" }));
afterEach(() => mock.resetHandlers());
afterAll(() => mock.close());

async function connectClient() {
  const server = createTdmcpServer(loadConfig({}), { logger: silentLogger });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "tdmcp-test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const hasImage = (content: unknown): boolean =>
  Array.isArray(content) && content.some((c) => (c as { type?: string }).type === "image");

describe("integration: Layer 1 artist tools over MCP", () => {
  it("registers all three tool layers (31+ tools)", async () => {
    const client = await connectClient();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "create_visual_system",
        "create_feedback_network",
        "create_generative_art",
        "create_node_chain",
        "create_td_node",
        "get_preview",
        "get_td_classes",
        "get_module_help",
        "get_td_performance",
        "duplicate_network",
        "create_data_visualization",
        "plan_visual",
      ]),
    );
    expect(tools.length).toBeGreaterThanOrEqual(31);
  });

  it("create_feedback_network builds a container and returns a preview", async () => {
    const client = await connectClient();
    const result = await client.callTool({
      name: "create_feedback_network",
      arguments: { seed_type: "noise", feedback_gain: 0.95 },
    });
    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result.content)).toContain("/project1/feedback_system");
    expect(hasImage(result.content)).toBe(true);
  });

  it("create_generative_art uses the reaction_diffusion recipe", async () => {
    const client = await connectClient();
    const result = await client.callTool({
      name: "create_generative_art",
      arguments: { technique: "reaction_diffusion" },
    });
    expect(result.isError).toBeFalsy();
    const text = JSON.stringify(result.content);
    expect(text).toContain("reaction_diffusion");
    expect(text).toContain("/project1/reaction_diffusion");
  });

  it("create_visual_system classifies an audio description", async () => {
    const client = await connectClient();
    const result = await client.callTool({
      name: "create_visual_system",
      arguments: { description: "an audio reactive spectrum that pulses to the beat" },
    });
    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result.content)).toContain("audio-reactive");
  });

  it("apply_post_processing chains effects onto a source", async () => {
    const client = await connectClient();
    const result = await client.callTool({
      name: "apply_post_processing",
      arguments: { source_path: "/project1/noise1", effects: ["bloom", "rgb_split", "vignette"] },
    });
    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result.content)).toContain("post_fx");
  });

  it("get_preview returns an image", async () => {
    const client = await connectClient();
    const result = await client.callTool({
      name: "get_preview",
      arguments: { node_path: "/project1/out1" },
    });
    expect(result.isError).toBeFalsy();
    expect(hasImage(result.content)).toBe(true);
  });
});
