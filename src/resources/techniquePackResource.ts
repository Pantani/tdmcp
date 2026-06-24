import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { firstVar, jsonContents, type ResourceRegistrar } from "./shared.js";

export interface TechniquePackSummary {
  id: string;
  name: string;
  description?: string;
  count?: number;
}

type TechniquePackKnowledge = {
  getTechniquePack?: (category: string) => unknown;
  listTechniquePacks?: () => TechniquePackSummary[];
  searchTechniques?: (
    query: string,
    limit?: number,
  ) => Array<{ id: string; name: string; description?: string }>;
};

function techniquePackKnowledge(knowledge: unknown): TechniquePackKnowledge {
  return knowledge as TechniquePackKnowledge;
}

function keyFromUri(uri: URL): string {
  return decodeURIComponent(uri.pathname.replace(/^\/+/, ""));
}

function categoryFromTemplate(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function techniqueSuggestions(knowledge: TechniquePackKnowledge, query: string): string[] {
  if (typeof knowledge.searchTechniques === "function") {
    return knowledge
      .searchTechniques(query, 5)
      .map((entry) => entry.id)
      .slice(0, 5);
  }
  if (typeof knowledge.listTechniquePacks === "function") {
    return knowledge
      .listTechniquePacks()
      .map((entry) => entry.id)
      .slice(0, 5);
  }
  return [];
}

export const registerTechniquePackResource: ResourceRegistrar = (server, ctx) => {
  const knowledge = techniquePackKnowledge(ctx.knowledge);
  const template = new ResourceTemplate("tdmcp://techniques/{category}", {
    list: async () => ({
      resources:
        typeof knowledge.listTechniquePacks === "function"
          ? knowledge.listTechniquePacks().map((entry) => ({
              uri: `tdmcp://techniques/${encodeURIComponent(entry.id)}`,
              name: entry.name,
              description: entry.description,
              mimeType: "application/json",
            }))
          : [],
    }),
    complete: {
      category: async (value) => techniqueSuggestions(knowledge, value),
    },
  });

  server.registerResource(
    "techniques",
    template,
    {
      title: "Bottobot technique packs",
      description: "Technique packs imported from Bottobot, keyed by technique category.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const category = categoryFromTemplate(firstVar(variables.category) || keyFromUri(uri));
      const pack =
        typeof knowledge.getTechniquePack === "function"
          ? knowledge.getTechniquePack(category)
          : undefined;

      if (!pack) {
        return jsonContents(uri, {
          error: `Technique pack "${category}" not found.`,
          suggestions: techniqueSuggestions(knowledge, category),
        });
      }

      return jsonContents(uri, pack);
    },
  );
};
