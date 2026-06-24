import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { decodeResourceValue, firstVar, jsonContents, type ResourceRegistrar } from "./shared.js";

export interface TouchDesignerVersionSummary {
  version: string;
  name?: string;
  releaseDate?: string;
  stability?: string;
  summary?: string;
}

type TdVersionKnowledge = {
  getTouchDesignerVersion?: (version: string) => unknown;
  listTouchDesignerVersions?: () => TouchDesignerVersionSummary[];
  searchTouchDesignerVersions?: (query: string, limit?: number) => TouchDesignerVersionSummary[];
};

function versionKnowledge(knowledge: unknown): TdVersionKnowledge {
  return knowledge as TdVersionKnowledge;
}

function versionLabel(entry: TouchDesignerVersionSummary): string {
  return entry.name ?? `TouchDesigner ${entry.version}`;
}

function versionDescription(entry: TouchDesignerVersionSummary): string | undefined {
  return entry.summary ?? entry.releaseDate ?? entry.stability;
}

function keyFromUri(uri: URL): string {
  return decodeResourceValue(uri.pathname.replace(/^\/+/, ""));
}

function versionSuggestions(knowledge: TdVersionKnowledge, query: string): string[] {
  if (typeof knowledge.searchTouchDesignerVersions === "function") {
    return knowledge
      .searchTouchDesignerVersions(query, 5)
      .map((entry) => entry.version)
      .slice(0, 5);
  }
  if (typeof knowledge.listTouchDesignerVersions === "function") {
    return knowledge
      .listTouchDesignerVersions()
      .map((entry) => entry.version)
      .slice(0, 5);
  }
  return [];
}

export const registerTdVersionResource: ResourceRegistrar = (server, ctx) => {
  const knowledge = versionKnowledge(ctx.knowledge);
  const template = new ResourceTemplate("tdmcp://td-versions/{version}", {
    list: async () => ({
      resources:
        typeof knowledge.listTouchDesignerVersions === "function"
          ? knowledge.listTouchDesignerVersions().map((entry) => ({
              uri: `tdmcp://td-versions/${encodeURIComponent(entry.version)}`,
              name: versionLabel(entry),
              description: versionDescription(entry),
              mimeType: "application/json",
            }))
          : [],
    }),
    complete: {
      version: async (value) => versionSuggestions(knowledge, value),
    },
  });

  server.registerResource(
    "td-versions",
    template,
    {
      title: "TouchDesigner versions",
      description: "Stable TouchDesigner release information keyed by build/version number.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const version = decodeResourceValue(firstVar(variables.version)) || keyFromUri(uri);
      const entry =
        typeof knowledge.getTouchDesignerVersion === "function"
          ? knowledge.getTouchDesignerVersion(version)
          : undefined;

      if (!entry) {
        return jsonContents(uri, {
          error: `TouchDesigner version "${version}" not found.`,
          suggestions: versionSuggestions(knowledge, version),
        });
      }

      return jsonContents(uri, entry);
    },
  );
};
