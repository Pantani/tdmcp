import type { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { registerTechniquePackResource } from "../../src/resources/techniquePackResource.js";

type RegisteredResource = {
  name: string;
  template: ResourceTemplate;
  metadata: { mimeType?: string; title?: string; description?: string };
  handler: (
    uri: URL,
    variables?: Record<string, string | string[] | undefined>,
  ) => Promise<{ contents: Array<{ uri?: string; mimeType?: string; text?: string }> }>;
};

function captureServer() {
  const calls: RegisteredResource[] = [];
  return {
    calls,
    server: {
      registerResource(
        name: string,
        template: ResourceTemplate,
        metadata: RegisteredResource["metadata"],
        handler: RegisteredResource["handler"],
      ) {
        calls.push({ name, template, metadata, handler });
      },
    },
  };
}

function registered(calls: RegisteredResource[]): RegisteredResource {
  const call = calls[0];
  if (!call) throw new Error("Resource was not registered.");
  return call;
}

function parsePayload(result: { contents: Array<{ text?: string }> }): unknown {
  return JSON.parse(result.contents[0]?.text ?? "{}");
}

describe("Technique pack resources", () => {
  it("registers, lists, completes, and reads Bottobot technique packs", async () => {
    const { calls, server } = captureServer();
    const knowledge = {
      getTechniquePack: (category: string) =>
        category === "feedback loops"
          ? {
              id: "feedback loops",
              name: "Feedback Loops",
              description: "Bottobot feedback and trails technique pack.",
              techniques: [{ id: "fb-echo", name: "Feedback Echo" }],
            }
          : undefined,
      listTechniquePacks: () => [
        {
          id: "feedback loops",
          name: "Feedback Loops",
          description: "Bottobot feedback and trails technique pack.",
          count: 1,
        },
      ],
      searchTechniques: (query: string, limit?: number) =>
        query === "missing"
          ? [{ id: "feedback loops", name: "Feedback Loops" }].slice(0, limit)
          : [
              {
                id: "feedback loops",
                name: "Feedback Loops",
                description: "Bottobot feedback and trails technique pack.",
              },
            ].slice(0, limit),
    };

    registerTechniquePackResource(server as never, { knowledge } as never);
    const resource = registered(calls);

    expect(resource.name).toBe("techniques");
    expect(resource.metadata.mimeType).toBe("application/json");

    const listResult = await resource.template.listCallback?.({} as never);
    expect(listResult?.resources).toEqual([
      expect.objectContaining({
        uri: "tdmcp://techniques/feedback%20loops",
        name: "Feedback Loops",
        description: "Bottobot feedback and trails technique pack.",
        mimeType: "application/json",
      }),
    ]);

    const completeCategory = resource.template.completeCallback?.("category");
    await expect(completeCategory?.("feed")).resolves.toEqual(["feedback loops"]);

    const readPayload = parsePayload(
      await resource.handler(new URL("tdmcp://techniques/feedback%20loops"), {
        category: "feedback%20loops",
      }),
    ) as { id?: string; techniques?: Array<{ id: string }> };
    expect(readPayload.id).toBe("feedback loops");
    expect(readPayload.techniques?.[0]?.id).toBe("fb-echo");

    const missingPayload = parsePayload(
      await resource.handler(new URL("tdmcp://techniques/missing"), { category: "missing" }),
    ) as { error?: string; suggestions?: string[] };
    expect(missingPayload.error).toContain('Technique pack "missing" not found');
    expect(missingPayload.suggestions).toEqual(["feedback loops"]);
  });
});
