import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { firstVar, jsonContents, type ResourceRegistrar } from "./shared.js";

export interface OperatorExampleGuideSummary {
  id: string;
  name: string;
  description?: string;
}

type OperatorExamplesKnowledge = {
  getOperatorExamples?: (operator: string) => unknown;
  searchOperatorExampleGuides?: (query: string, limit?: number) => OperatorExampleGuideSummary[];
};

function operatorExamplesKnowledge(knowledge: unknown): OperatorExamplesKnowledge {
  return knowledge as OperatorExamplesKnowledge;
}

function keyFromUri(uri: URL): string {
  return decodeURIComponent(uri.pathname.replace(/^\/+/, ""));
}

function operatorFromTemplate(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function guideSuggestions(knowledge: OperatorExamplesKnowledge, query: string): string[] {
  if (typeof knowledge.searchOperatorExampleGuides !== "function") return [];
  return knowledge
    .searchOperatorExampleGuides(query, 5)
    .map((entry) => entry.id)
    .slice(0, 5);
}

export const registerOperatorExamplesResource: ResourceRegistrar = (server, ctx) => {
  const knowledge = operatorExamplesKnowledge(ctx.knowledge);
  const template = new ResourceTemplate("tdmcp://operator-examples/{operator}", {
    list: async () => ({
      resources:
        typeof knowledge.searchOperatorExampleGuides === "function"
          ? knowledge.searchOperatorExampleGuides("", 50).map((entry) => ({
              uri: `tdmcp://operator-examples/${encodeURIComponent(entry.id)}`,
              name: `Operator examples: ${entry.name}`,
              description: entry.description,
              mimeType: "application/json",
            }))
          : [],
    }),
    complete: {
      operator: async (value) =>
        typeof knowledge.searchOperatorExampleGuides === "function"
          ? knowledge.searchOperatorExampleGuides(value, 50).map((entry) => entry.id)
          : [],
    },
  });

  server.registerResource(
    "operator-examples",
    template,
    {
      title: "Operator examples",
      description:
        "Workflow intelligence examples for TouchDesigner operators, including Python snippets, expressions, usage patterns, and tips.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const operator = operatorFromTemplate(firstVar(variables.operator) || keyFromUri(uri));
      const guide =
        typeof knowledge.getOperatorExamples === "function"
          ? knowledge.getOperatorExamples(operator)
          : undefined;

      if (!guide) {
        return jsonContents(uri, {
          error: `Operator example guide "${operator}" not found.`,
          suggestions: guideSuggestions(knowledge, operator),
        });
      }

      return jsonContents(uri, guide);
    },
  );
};
