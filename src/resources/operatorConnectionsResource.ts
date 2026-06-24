import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { firstVar, jsonContents, type ResourceRegistrar } from "./shared.js";

export interface OperatorWorkflowGuideSummary {
  id: string;
  name: string;
  description?: string;
}

type OperatorConnectionsKnowledge = {
  getOperatorConnections?: (operator: string) => unknown;
  searchOperatorConnectionGuides?: (
    query: string,
    limit?: number,
  ) => OperatorWorkflowGuideSummary[];
};

function operatorConnectionsKnowledge(knowledge: unknown): OperatorConnectionsKnowledge {
  return knowledge as OperatorConnectionsKnowledge;
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

function guideSuggestions(knowledge: OperatorConnectionsKnowledge, query: string): string[] {
  if (typeof knowledge.searchOperatorConnectionGuides !== "function") return [];
  return knowledge
    .searchOperatorConnectionGuides(query, 5)
    .map((entry) => entry.id)
    .slice(0, 5);
}

export const registerOperatorConnectionsResource: ResourceRegistrar = (server, ctx) => {
  const knowledge = operatorConnectionsKnowledge(ctx.knowledge);
  const template = new ResourceTemplate("tdmcp://operator-connections/{operator}", {
    list: async () => ({
      resources:
        typeof knowledge.searchOperatorConnectionGuides === "function"
          ? knowledge.searchOperatorConnectionGuides("", 50).map((entry) => ({
              uri: `tdmcp://operator-connections/${encodeURIComponent(entry.id)}`,
              name: `Operator connections: ${entry.name}`,
              description: entry.description,
              mimeType: "application/json",
            }))
          : [],
    }),
    complete: {
      operator: async (value) =>
        typeof knowledge.searchOperatorConnectionGuides === "function"
          ? knowledge.searchOperatorConnectionGuides(value, 50).map((entry) => entry.id)
          : [],
    },
  });

  server.registerResource(
    "operator-connections",
    template,
    {
      title: "Operator connection guidance",
      description:
        "Workflow intelligence for how a TouchDesigner operator connects to likely inputs, outputs, and neighboring patterns.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const operator = operatorFromTemplate(firstVar(variables.operator) || keyFromUri(uri));
      const guide =
        typeof knowledge.getOperatorConnections === "function"
          ? knowledge.getOperatorConnections(operator)
          : undefined;

      if (!guide) {
        return jsonContents(uri, {
          error: `Operator connection guide "${operator}" not found.`,
          suggestions: guideSuggestions(knowledge, operator),
        });
      }

      return jsonContents(uri, guide);
    },
  );
};
