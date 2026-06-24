import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { firstVar, jsonContents, type ResourceRegistrar } from "./shared.js";

export interface CompatibilitySummary {
  id: string;
  name: string;
  description?: string;
}

type CompatibilityKnowledge = {
  getOperatorCompatibility?: (operator: string) => unknown;
  searchOperatorCompatibility?: (query: string, limit?: number) => CompatibilitySummary[];
  getPythonApiCompatibility?: (ref: string) => unknown;
  searchPythonApiCompatibility?: (query: string, limit?: number) => CompatibilitySummary[];
};

function compatibilityKnowledge(knowledge: unknown): CompatibilityKnowledge {
  return knowledge as CompatibilityKnowledge;
}

function keyFromUri(uri: URL): string {
  return decodeValue(uri.pathname.replace(/^\/+/, ""));
}

function decodeValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function suggestions(
  search: ((query: string, limit?: number) => CompatibilitySummary[]) | undefined,
  query: string,
): string[] {
  if (typeof search !== "function") return [];
  return search(query, 5)
    .map((entry) => entry.id)
    .slice(0, 5);
}

export const registerOperatorCompatibilityResource: ResourceRegistrar = (server, ctx) => {
  const knowledge = compatibilityKnowledge(ctx.knowledge);
  const template = new ResourceTemplate("tdmcp://compat/operators/{operator}", {
    list: async () => ({
      resources:
        typeof knowledge.searchOperatorCompatibility === "function"
          ? knowledge.searchOperatorCompatibility("", 50).map((entry) => ({
              uri: `tdmcp://compat/operators/${encodeURIComponent(entry.id)}`,
              name: `Operator compatibility: ${entry.name}`,
              description: entry.description,
              mimeType: "application/json",
            }))
          : [],
    }),
    complete: {
      operator: async (value) =>
        typeof knowledge.searchOperatorCompatibility === "function"
          ? knowledge.searchOperatorCompatibility(value, 50).map((entry) => entry.id)
          : [],
    },
  });

  server.registerResource(
    "operator-compatibility",
    template,
    {
      title: "TouchDesigner operator compatibility",
      description: "Version compatibility records for TouchDesigner operators.",
      mimeType: "application/json",
    },
    async (uri, variables = {}) => {
      const operator = decodeValue(firstVar(variables.operator) || keyFromUri(uri));
      const record =
        typeof knowledge.getOperatorCompatibility === "function"
          ? knowledge.getOperatorCompatibility(operator)
          : undefined;

      if (!record) {
        return jsonContents(uri, {
          error: `Operator compatibility "${operator}" not found.`,
          suggestions: suggestions(knowledge.searchOperatorCompatibility, operator),
        });
      }

      return jsonContents(uri, record);
    },
  );
};

export const registerPythonApiCompatibilityResource: ResourceRegistrar = (server, ctx) => {
  const knowledge = compatibilityKnowledge(ctx.knowledge);
  const template = new ResourceTemplate("tdmcp://compat/python/{class_or_member}", {
    list: async () => ({
      resources:
        typeof knowledge.searchPythonApiCompatibility === "function"
          ? knowledge.searchPythonApiCompatibility("", 50).map((entry) => ({
              uri: `tdmcp://compat/python/${encodeURIComponent(entry.id)}`,
              name: `Python API compatibility: ${entry.name}`,
              description: entry.description,
              mimeType: "application/json",
            }))
          : [],
    }),
    complete: {
      class_or_member: async (value) =>
        typeof knowledge.searchPythonApiCompatibility === "function"
          ? knowledge.searchPythonApiCompatibility(value, 50).map((entry) => entry.id)
          : [],
    },
  });

  server.registerResource(
    "python-api-compatibility",
    template,
    {
      title: "TouchDesigner Python API compatibility",
      description: "Version compatibility records for TouchDesigner Python classes and members.",
      mimeType: "application/json",
    },
    async (uri, variables = {}) => {
      const ref = decodeValue(firstVar(variables.class_or_member) || keyFromUri(uri));
      const record =
        typeof knowledge.getPythonApiCompatibility === "function"
          ? knowledge.getPythonApiCompatibility(ref)
          : undefined;

      if (!record) {
        return jsonContents(uri, {
          error: `Python API compatibility "${ref}" not found.`,
          suggestions: suggestions(knowledge.searchPythonApiCompatibility, ref),
        });
      }

      return jsonContents(uri, record);
    },
  );
};
