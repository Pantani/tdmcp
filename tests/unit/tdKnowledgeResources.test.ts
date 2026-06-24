import type { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { registerExperimentalTechniqueResource } from "../../src/resources/experimentalTechniqueResource.js";
import { registerTdVersionResource } from "../../src/resources/tdVersionResource.js";

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

describe("TouchDesigner version resources", () => {
  it("lists and reads stable TouchDesigner version data as JSON resources", async () => {
    const { calls, server } = captureServer();
    const knowledge = {
      getTouchDesignerVersion: (version: string) =>
        version === "2023.11760"
          ? {
              version: "2023.11760",
              releaseDate: "2023-08-08",
              stability: "stable",
              summary: "Production release with Vulkan renderer updates.",
            }
          : undefined,
      listTouchDesignerVersions: () => [
        {
          version: "2023.11760",
          releaseDate: "2023-08-08",
          stability: "stable",
          summary: "Production release with Vulkan renderer updates.",
        },
      ],
      searchTouchDesignerVersions: () => [{ version: "2023.11760" }],
    };

    registerTdVersionResource(server as never, { knowledge } as never);
    const resource = registered(calls);

    expect(resource.name).toBe("td-versions");
    expect(resource.metadata.mimeType).toBe("application/json");

    const listResult = await resource.template.listCallback?.({} as never);
    expect(listResult?.resources).toEqual([
      expect.objectContaining({
        uri: "tdmcp://td-versions/2023.11760",
        name: "TouchDesigner 2023.11760",
        mimeType: "application/json",
      }),
    ]);

    const readPayload = parsePayload(
      await resource.handler(new URL("tdmcp://td-versions/2023.11760"), {
        version: "2023.11760",
      }),
    ) as { version?: string; stability?: string };
    expect(readPayload).toMatchObject({ version: "2023.11760", stability: "stable" });

    const missingPayload = parsePayload(
      await resource.handler(new URL("tdmcp://td-versions/missing"), { version: "missing" }),
    ) as { error?: string; suggestions?: string[] };
    expect(missingPayload.error).toContain('TouchDesigner version "missing" not found');
    expect(missingPayload.suggestions).toEqual(["2023.11760"]);
  });
});

describe("TouchDesigner experimental resources", () => {
  it("lists and reads experimental build or technique groups as JSON resources", async () => {
    const { calls, server } = captureServer();
    const knowledge = {
      getTouchDesignerExperimental: (seriesOrCategory: string) =>
        seriesOrCategory === "glsl"
          ? {
              id: "glsl",
              name: "Experimental GLSL techniques",
              description: "Experimental shader workflows imported from the TouchDesigner KB.",
              techniques: [{ id: "feedback-glow", name: "Feedback Glow", status: "experimental" }],
            }
          : undefined,
      listTouchDesignerExperimentals: () => [
        {
          id: "glsl",
          name: "Experimental GLSL techniques",
          description: "Experimental shader workflows imported from the TouchDesigner KB.",
          count: 1,
        },
      ],
      searchTouchDesignerExperimentals: () => [
        { id: "glsl", name: "Experimental GLSL techniques" },
      ],
    };

    registerExperimentalTechniqueResource(server as never, { knowledge } as never);
    const resource = registered(calls);

    expect(resource.name).toBe("td-experimental");
    expect(resource.metadata.mimeType).toBe("application/json");

    const listResult = await resource.template.listCallback?.({} as never);
    expect(listResult?.resources).toEqual([
      expect.objectContaining({
        uri: "tdmcp://td-experimental/glsl",
        name: "Experimental GLSL techniques",
        mimeType: "application/json",
      }),
    ]);

    const readPayload = parsePayload(
      await resource.handler(new URL("tdmcp://td-experimental/glsl"), {
        series_or_category: "glsl",
      }),
    ) as { id?: string; techniques?: Array<{ id: string }> };
    expect(readPayload.techniques?.[0]?.id).toBe("feedback-glow");

    const missingPayload = parsePayload(
      await resource.handler(new URL("tdmcp://td-experimental/missing"), {
        series_or_category: "missing",
      }),
    ) as { error?: string; suggestions?: string[] };
    expect(missingPayload.error).toContain('Experimental TouchDesigner entry "missing" not found');
    expect(missingPayload.suggestions).toEqual(["glsl"]);
  });
});
