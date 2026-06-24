import type { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { registerTdClassResource } from "../../src/resources/tdClassResource.js";

type RegisteredResource = {
  name: string;
  template: ResourceTemplate;
  metadata: { mimeType?: string; title?: string; description?: string };
  handler: (
    uri: URL,
    variables?: Record<string, string | string[] | undefined>,
  ) => Promise<{ contents: Array<{ mimeType?: string; text?: string }> }>;
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

function parsePayload(result: { contents: Array<{ text?: string }> }): unknown {
  return JSON.parse(result.contents[0]?.text ?? "{}");
}

function registered(calls: RegisteredResource[]): RegisteredResource {
  const call = calls[0];
  if (!call) throw new Error("Resource was not registered.");
  return call;
}

describe("TouchDesigner class resource", () => {
  it("registers, lists, completes, and reads TouchDesigner class families", async () => {
    const { calls, server } = captureServer();
    const knowledge = {
      getTouchDesignerClass: (family: string) =>
        family === "TOP"
          ? {
              id: "TOP",
              name: "TOP",
              description: "Texture operator family.",
              classes: [{ name: "TOP", kind: "base" }],
            }
          : undefined,
      listTouchDesignerClasses: () => [
        { id: "TOP", name: "TOP", description: "Texture operator family." },
        { id: "CHOP", name: "CHOP", description: "Channel operator family." },
      ],
      searchTouchDesignerClasses: (_query: string, limit?: number) =>
        [
          { id: "TOP", name: "TOP", description: "Texture operator family." },
          { id: "CHOP", name: "CHOP", description: "Channel operator family." },
        ].slice(0, limit ?? 50),
    };

    registerTdClassResource(server as never, { knowledge } as never);
    const resource = registered(calls);

    expect(resource.name).toBe("td-classes");
    expect(resource.metadata.mimeType).toBe("application/json");

    const listResult = await resource.template.listCallback?.({} as never);
    expect(listResult?.resources).toEqual([
      expect.objectContaining({
        uri: "tdmcp://td-classes/TOP",
        name: "TouchDesigner class family: TOP",
        description: "Texture operator family.",
        mimeType: "application/json",
      }),
      expect.objectContaining({
        uri: "tdmcp://td-classes/CHOP",
        name: "TouchDesigner class family: CHOP",
      }),
    ]);

    const completeFamily = resource.template.completeCallback?.("family");
    await expect(completeFamily?.("TO")).resolves.toEqual(["TOP", "CHOP"]);

    const readPayload = parsePayload(
      await resource.handler(new URL("tdmcp://td-classes/TOP"), { family: "TOP" }),
    ) as { id?: string; name?: string; classes?: Array<{ name: string }> };
    expect(readPayload).toMatchObject({ id: "TOP", name: "TOP" });
    expect(readPayload.classes?.[0]?.name).toBe("TOP");
  });

  it("decodes percent-encoded variables and returns suggestions for missing families", async () => {
    const { calls, server } = captureServer();
    const knowledge = {
      getTouchDesignerClass: (family: string) =>
        family === "Panel COMP"
          ? {
              id: "Panel COMP",
              name: "Panel COMP",
              description: "Panel component classes.",
            }
          : undefined,
      listTouchDesignerClasses: () => [{ id: "Panel COMP", name: "Panel COMP" }],
      searchTouchDesignerClasses: (_query: string, limit?: number) =>
        [
          { id: "Panel COMP", name: "Panel COMP" },
          { id: "COMP", name: "COMP" },
        ].slice(0, limit ?? 50),
    };

    registerTdClassResource(server as never, { knowledge } as never);
    const resource = registered(calls);

    const decodedPayload = parsePayload(
      await resource.handler(new URL("tdmcp://td-classes/Panel%20COMP"), {
        family: "Panel%20COMP",
      }),
    ) as { id?: string; name?: string };
    expect(decodedPayload).toMatchObject({ id: "Panel COMP", name: "Panel COMP" });

    const missingPayload = parsePayload(
      await resource.handler(new URL("tdmcp://td-classes/missing"), { family: "missing" }),
    ) as { error?: string; suggestions?: string[] };
    expect(missingPayload.error).toContain('TouchDesigner class family "missing" not found');
    expect(missingPayload.suggestions).toEqual(["Panel COMP", "COMP"]);
  });
});
