import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { decodeResourceValue, firstVar, jsonContents, type ResourceRegistrar } from "./shared.js";

export interface TouchDesignerExperimentalSummary {
  id: string;
  name?: string;
  description?: string;
  count?: number;
}

type ExperimentalKnowledge = {
  getTouchDesignerExperimental?: (seriesOrCategory: string) => unknown;
  listTouchDesignerExperimentals?: () => TouchDesignerExperimentalSummary[];
  searchTouchDesignerExperimentals?: (
    query: string,
    limit?: number,
  ) => TouchDesignerExperimentalSummary[];
};

function experimentalKnowledge(knowledge: unknown): ExperimentalKnowledge {
  return knowledge as ExperimentalKnowledge;
}

function experimentalLabel(entry: TouchDesignerExperimentalSummary): string {
  return entry.name ?? `TouchDesigner experimental: ${entry.id}`;
}

function keyFromUri(uri: URL): string {
  return decodeResourceValue(uri.pathname.replace(/^\/+/, ""));
}

function experimentalSuggestions(knowledge: ExperimentalKnowledge, query: string): string[] {
  if (typeof knowledge.searchTouchDesignerExperimentals === "function") {
    return knowledge
      .searchTouchDesignerExperimentals(query, 5)
      .map((entry) => entry.id)
      .slice(0, 5);
  }
  if (typeof knowledge.listTouchDesignerExperimentals === "function") {
    return knowledge
      .listTouchDesignerExperimentals()
      .map((entry) => entry.id)
      .slice(0, 5);
  }
  return [];
}

export const registerExperimentalTechniqueResource: ResourceRegistrar = (server, ctx) => {
  const knowledge = experimentalKnowledge(ctx.knowledge);
  const template = new ResourceTemplate("tdmcp://td-experimental/{series_or_category}", {
    list: async () => ({
      resources:
        typeof knowledge.listTouchDesignerExperimentals === "function"
          ? knowledge.listTouchDesignerExperimentals().map((entry) => ({
              uri: `tdmcp://td-experimental/${encodeURIComponent(entry.id)}`,
              name: experimentalLabel(entry),
              description: entry.description,
              mimeType: "application/json",
            }))
          : [],
    }),
    complete: {
      series_or_category: async (value) => experimentalSuggestions(knowledge, value),
    },
  });

  server.registerResource(
    "td-experimental",
    template,
    {
      title: "TouchDesigner experimental builds and techniques",
      description:
        "Experimental TouchDesigner build-series or technique data keyed by series/category.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const seriesOrCategory =
        decodeResourceValue(firstVar(variables.series_or_category)) || keyFromUri(uri);
      const entry =
        typeof knowledge.getTouchDesignerExperimental === "function"
          ? knowledge.getTouchDesignerExperimental(seriesOrCategory)
          : undefined;

      if (!entry) {
        return jsonContents(uri, {
          error: `Experimental TouchDesigner entry "${seriesOrCategory}" not found.`,
          suggestions: experimentalSuggestions(knowledge, seriesOrCategory),
        });
      }

      return jsonContents(uri, entry);
    },
  );
};
