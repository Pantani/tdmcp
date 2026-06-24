import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { firstVar, jsonContents, type ResourceRegistrar } from "./shared.js";

export interface TouchDesignerClassSummary {
  id: string;
  name: string;
  description?: string;
}

type TdClassKnowledge = {
  listTouchDesignerClasses?: () => TouchDesignerClassSummary[];
  getTouchDesignerClass?: (family: string) => unknown;
  searchTouchDesignerClasses?: (query: string, limit?: number) => TouchDesignerClassSummary[];
};

function classKnowledge(knowledge: unknown): TdClassKnowledge {
  return knowledge as TdClassKnowledge;
}

function decodeValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function familyFromUri(uri: URL): string {
  return decodeValue(uri.pathname.replace(/^\/+/, ""));
}

function classSuggestions(knowledge: TdClassKnowledge, query: string): string[] {
  if (typeof knowledge.searchTouchDesignerClasses === "function") {
    return knowledge
      .searchTouchDesignerClasses(query, 5)
      .map((entry) => entry.id)
      .slice(0, 5);
  }
  if (typeof knowledge.listTouchDesignerClasses === "function") {
    return knowledge
      .listTouchDesignerClasses()
      .map((entry) => entry.id)
      .slice(0, 5);
  }
  return [];
}

export const registerTdClassResource: ResourceRegistrar = (server, ctx) => {
  const knowledge = classKnowledge(ctx.knowledge);
  const template = new ResourceTemplate("tdmcp://td-classes/{family}", {
    list: async () => ({
      resources:
        typeof knowledge.listTouchDesignerClasses === "function"
          ? knowledge.listTouchDesignerClasses().map((entry) => ({
              uri: `tdmcp://td-classes/${encodeURIComponent(entry.id)}`,
              name: `TouchDesigner class family: ${entry.name}`,
              description: entry.description,
              mimeType: "application/json",
            }))
          : [],
    }),
    complete: {
      family: async (value) => classSuggestions(knowledge, value),
    },
  });

  server.registerResource(
    "td-classes",
    template,
    {
      title: "TouchDesigner class families",
      description:
        "TouchDesigner class and operator-family data imported from Bottobot wiki/data/classes.",
      mimeType: "application/json",
    },
    async (uri, variables = {}) => {
      const family = decodeValue(firstVar(variables.family) || familyFromUri(uri));
      const entry =
        typeof knowledge.getTouchDesignerClass === "function"
          ? knowledge.getTouchDesignerClass(family)
          : undefined;

      if (!entry) {
        return jsonContents(uri, {
          error: `TouchDesigner class family "${family}" not found.`,
          suggestions: classSuggestions(knowledge, family),
        });
      }

      return jsonContents(uri, entry);
    },
  );
};
