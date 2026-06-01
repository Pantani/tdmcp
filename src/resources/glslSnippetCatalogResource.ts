import type { KnowledgeBase } from "../knowledge/index.js";
import { jsonContents, type ResourceRegistrar } from "./shared.js";

export interface GlslSnippetCatalogEntry {
  id: string;
  name: string;
  difficulty: string;
  description: string;
  resourceUri: string;
  operators: string[];
  tags: string[];
  snippet: string;
  snippetBytes: number;
  assemblyHint: string;
}

export interface GlslSnippetCatalog {
  uri: "tdmcp://glsl-snippets";
  count: number;
  licensePolicy: {
    status: "tdmcp-vetted";
    note: string;
  };
  snippets: GlslSnippetCatalogEntry[];
}

export function readGlslSnippetCatalog(knowledge: KnowledgeBase): GlslSnippetCatalog {
  const snippets = knowledge
    .listGlslPatterns()
    .map((summary): GlslSnippetCatalogEntry | undefined => {
      const full = knowledge.getGlslPattern(summary.id);
      const snippet = full?.code?.snippet ?? "";
      if (!full || !snippet.trim()) return undefined;
      return {
        id: full.id,
        name: full.name,
        difficulty: full.difficulty ?? summary.difficulty,
        description: full.description ?? summary.description,
        resourceUri: `tdmcp://glsl/${full.id}`,
        operators: full.operators ?? [],
        tags: full.tags ?? [],
        snippet,
        snippetBytes: Buffer.byteLength(snippet, "utf8"),
        assemblyHint:
          full.setup ??
          "Create a GLSL TOP, write this fragment shader into a sibling Text DAT, and assign that DAT to the GLSL TOP pixeldat parameter.",
      };
    })
    .filter((entry): entry is GlslSnippetCatalogEntry => entry !== undefined);

  return {
    uri: "tdmcp://glsl-snippets",
    count: snippets.length,
    licensePolicy: {
      status: "tdmcp-vetted",
      note: "Curated snippets shipped with tdmcp for agent assembly. Prefer these over unvetted web shader libraries.",
    },
    snippets,
  };
}

export const registerGlslSnippetCatalogResource: ResourceRegistrar = (server, ctx) => {
  server.registerResource(
    "td-glsl-snippets",
    "tdmcp://glsl-snippets",
    {
      title: "GLSL snippet catalog",
      description:
        "A vetted, license-clean catalog of embedded GLSL snippets that agents can assemble into GLSL TOP networks without guessing resource ids.",
      mimeType: "application/json",
    },
    async (uri) => jsonContents(uri, readGlslSnippetCatalog(ctx.knowledge)),
  );
};
