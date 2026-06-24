import type { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import {
  registerOperatorCompatibilityResource,
  registerPythonApiCompatibilityResource,
} from "../../src/resources/compatibilityResource.js";

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

function registered(calls: RegisteredResource[], name: string): RegisteredResource {
  const call = calls.find((entry) => entry.name === name);
  if (!call) throw new Error(`Resource "${name}" was not registered.`);
  return call;
}

describe("TouchDesigner compatibility resources", () => {
  it("registers, lists, completes, and reads operator compatibility", async () => {
    const { calls, server } = captureServer();
    const knowledge = {
      getOperatorCompatibility: (operator: string) =>
        operator === "Feedback TOP"
          ? { name: "Feedback TOP", addedIn: "099", changedIn: [{ version: "2023" }] }
          : undefined,
      searchOperatorCompatibility: (_query: string, limit?: number) =>
        [
          {
            id: "feedback_top",
            name: "Feedback TOP",
            description: "Compatibility notes for recursive texture feedback.",
          },
          { id: "level_top", name: "Level TOP" },
        ].slice(0, limit ?? 50),
    };

    registerOperatorCompatibilityResource(server as never, { knowledge } as never);
    const resource = registered(calls, "operator-compatibility");

    expect(resource.metadata.mimeType).toBe("application/json");

    const listResult = await resource.template.listCallback?.({} as never);
    expect(listResult?.resources).toEqual([
      expect.objectContaining({
        uri: "tdmcp://compat/operators/feedback_top",
        name: "Operator compatibility: Feedback TOP",
        description: "Compatibility notes for recursive texture feedback.",
        mimeType: "application/json",
      }),
      expect.objectContaining({
        uri: "tdmcp://compat/operators/level_top",
        name: "Operator compatibility: Level TOP",
      }),
    ]);

    const completeOperator = resource.template.completeCallback?.("operator");
    await expect(completeOperator?.("feed")).resolves.toEqual(["feedback_top", "level_top"]);

    const readPayload = parsePayload(
      await resource.handler(new URL("tdmcp://compat/operators/Feedback%20TOP"), {
        operator: "Feedback%20TOP",
      }),
    ) as { name?: string; addedIn?: string };
    expect(readPayload).toMatchObject({ name: "Feedback TOP", addedIn: "099" });

    const missingPayload = parsePayload(
      await resource.handler(new URL("tdmcp://compat/operators/missing"), {
        operator: "missing",
      }),
    ) as { error?: string; suggestions?: string[] };
    expect(missingPayload.error).toContain('Operator compatibility "missing" not found');
    expect(missingPayload.suggestions).toEqual(["feedback_top", "level_top"]);
  });

  it("registers, lists, completes, and reads Python API compatibility", async () => {
    const { calls, server } = captureServer();
    const knowledge = {
      getPythonApiCompatibility: (ref: string) =>
        ref === "OP.cook"
          ? {
              class: "OP",
              name: "cook",
              kind: "method",
              addedIn: "099",
              description: "Force an operator to cook.",
            }
          : undefined,
      searchPythonApiCompatibility: (_query: string, limit?: number) =>
        [
          {
            id: "OP.cook",
            name: "OP.cook",
            description: "Compatibility for OP.cook().",
          },
          { id: "OP.path", name: "OP.path" },
        ].slice(0, limit ?? 50),
    };

    registerPythonApiCompatibilityResource(server as never, { knowledge } as never);
    const resource = registered(calls, "python-api-compatibility");

    expect(resource.metadata.mimeType).toBe("application/json");

    const listResult = await resource.template.listCallback?.({} as never);
    expect(listResult?.resources).toEqual([
      expect.objectContaining({
        uri: "tdmcp://compat/python/OP.cook",
        name: "Python API compatibility: OP.cook",
        description: "Compatibility for OP.cook().",
        mimeType: "application/json",
      }),
      expect.objectContaining({
        uri: "tdmcp://compat/python/OP.path",
        name: "Python API compatibility: OP.path",
      }),
    ]);

    const completeRef = resource.template.completeCallback?.("class_or_member");
    await expect(completeRef?.("OP")).resolves.toEqual(["OP.cook", "OP.path"]);

    const readPayload = parsePayload(
      await resource.handler(new URL("tdmcp://compat/python/OP.cook"), {
        class_or_member: "OP%2Ecook",
      }),
    ) as { class?: string; name?: string; kind?: string };
    expect(readPayload).toMatchObject({ class: "OP", name: "cook", kind: "method" });

    const missingPayload = parsePayload(
      await resource.handler(new URL("tdmcp://compat/python/missing"), {
        class_or_member: "missing",
      }),
    ) as { error?: string; suggestions?: string[] };
    expect(missingPayload.error).toContain('Python API compatibility "missing" not found');
    expect(missingPayload.suggestions).toEqual(["OP.cook", "OP.path"]);
  });
});
