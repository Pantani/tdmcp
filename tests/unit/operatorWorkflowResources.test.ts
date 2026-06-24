import type { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { registerOperatorConnectionsResource } from "../../src/resources/operatorConnectionsResource.js";
import { registerOperatorExamplesResource } from "../../src/resources/operatorExamplesResource.js";

type RegisteredResource = {
  name: string;
  template: ResourceTemplate;
  metadata: { mimeType?: string; title?: string; description?: string };
  handler: (
    uri: URL,
    variables?: Record<string, string | string[] | undefined>,
  ) => Promise<{ contents: Array<{ mimeType?: string; text?: string }> }>;
};

type CapturedServer = {
  calls: RegisteredResource[];
  server: {
    registerResource: (
      name: string,
      template: ResourceTemplate,
      metadata: RegisteredResource["metadata"],
      handler: RegisteredResource["handler"],
    ) => void;
  };
};

function captureServer(): CapturedServer {
  const calls: RegisteredResource[] = [];
  return {
    calls,
    server: {
      registerResource(name, template, metadata, handler) {
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

describe("operator workflow resources", () => {
  it("registers and reads operator connection guidance", async () => {
    const { calls, server } = captureServer();
    const knowledge = {
      getOperatorConnections: (operator: string) =>
        operator === "Feedback TOP"
          ? {
              operator: { name: "Feedback TOP", family: "TOP" },
              inputs: [{ op: "Noise TOP", reason: "Generative seed texture" }],
              outputs: [{ op: "Null TOP", reason: "Stable downstream target" }],
            }
          : undefined,
      searchOperatorConnectionGuides: (query: string, limit?: number) =>
        query === "missing" || limit === 5
          ? [
              {
                id: "feedback_top",
                name: "Feedback TOP",
                description: "Recursive image feedback workflow guidance.",
              },
            ]
          : [
              {
                id: "feedback_top",
                name: "Feedback TOP",
                description: "Recursive image feedback workflow guidance.",
              },
              { id: "level_top", name: "Level TOP" },
            ],
    };

    registerOperatorConnectionsResource(server as never, { knowledge } as never);
    const resource = registered(calls);

    expect(resource.name).toBe("operator-connections");
    expect(resource.metadata.mimeType).toBe("application/json");

    const listResult = await resource.template.listCallback?.({} as never);
    expect(listResult?.resources).toEqual([
      expect.objectContaining({
        uri: "tdmcp://operator-connections/feedback_top",
        name: "Operator connections: Feedback TOP",
        description: "Recursive image feedback workflow guidance.",
        mimeType: "application/json",
      }),
      expect.objectContaining({
        uri: "tdmcp://operator-connections/level_top",
        name: "Operator connections: Level TOP",
      }),
    ]);

    const completeOperator = resource.template.completeCallback?.("operator");
    const completions = await completeOperator?.("feed");
    expect(completions).toEqual(["feedback_top", "level_top"]);

    const readPayload = parsePayload(
      await resource.handler(new URL("tdmcp://operator-connections/Feedback%20TOP"), {
        operator: "Feedback TOP",
      }),
    ) as { operator?: { name?: string }; outputs?: Array<{ op: string }> };
    expect(readPayload.operator?.name).toBe("Feedback TOP");
    expect(readPayload.outputs?.[0]?.op).toBe("Null TOP");

    const missingPayload = parsePayload(
      await resource.handler(new URL("tdmcp://operator-connections/missing"), {
        operator: "missing",
      }),
    ) as { error?: string; suggestions?: string[] };
    expect(missingPayload.error).toContain('Operator connection guide "missing" not found');
    expect(missingPayload.suggestions).toEqual(["feedback_top"]);
  });

  it("registers and reads operator example guidance", async () => {
    const { calls, server } = captureServer();
    const knowledge = {
      getOperatorExamples: (operator: string) =>
        operator === "Feedback TOP"
          ? {
              operator: { name: "Feedback TOP", family: "TOP" },
              pythonExamples: [{ title: "Set target", language: "python" }],
              expressions: [{ title: "Target path", code: "op('null1').path" }],
            }
          : undefined,
      searchOperatorExampleGuides: (_query: string, limit?: number) =>
        [
          {
            id: "feedback_top",
            name: "Feedback TOP",
            description: "Python and expression examples for Feedback TOP.",
          },
          { id: "noise_top", name: "Noise TOP" },
        ].slice(0, limit ?? 50),
    };

    registerOperatorExamplesResource(server as never, { knowledge } as never);
    const resource = registered(calls);

    expect(resource.name).toBe("operator-examples");
    expect(resource.metadata.mimeType).toBe("application/json");

    const listResult = await resource.template.listCallback?.({} as never);
    expect(listResult?.resources).toEqual([
      expect.objectContaining({
        uri: "tdmcp://operator-examples/feedback_top",
        name: "Operator examples: Feedback TOP",
        description: "Python and expression examples for Feedback TOP.",
        mimeType: "application/json",
      }),
      expect.objectContaining({
        uri: "tdmcp://operator-examples/noise_top",
        name: "Operator examples: Noise TOP",
      }),
    ]);

    const completeOperator = resource.template.completeCallback?.("operator");
    const completions = await completeOperator?.("feed");
    expect(completions).toEqual(["feedback_top", "noise_top"]);

    const readPayload = parsePayload(
      await resource.handler(new URL("tdmcp://operator-examples/Feedback%20TOP"), {
        operator: "Feedback TOP",
      }),
    ) as { pythonExamples?: Array<{ title: string }>; expressions?: Array<{ title: string }> };
    expect(readPayload.pythonExamples?.[0]?.title).toBe("Set target");
    expect(readPayload.expressions?.[0]?.title).toBe("Target path");

    const missingPayload = parsePayload(
      await resource.handler(new URL("tdmcp://operator-examples/missing"), {
        operator: "missing",
      }),
    ) as { error?: string; suggestions?: string[] };
    expect(missingPayload.error).toContain('Operator example guide "missing" not found');
    expect(missingPayload.suggestions).toEqual(["feedback_top", "noise_top"]);
  });
});
