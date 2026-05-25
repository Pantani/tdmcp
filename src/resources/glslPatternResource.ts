import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { firstVar, jsonContents, type ResourceRegistrar } from "./shared.js";

export const registerGlslPatternResource: ResourceRegistrar = (server, ctx) => {
  const template = new ResourceTemplate("tdmcp://glsl/{pattern_name}", {
    list: async () => ({
      resources: ctx.knowledge.listGlslPatterns().map((pattern) => ({
        uri: `tdmcp://glsl/${pattern.id}`,
        name: pattern.name,
        description: `${pattern.difficulty} — ${pattern.description}`,
        mimeType: "application/json",
      })),
    }),
  });

  server.registerResource(
    "td-glsl",
    template,
    {
      title: "GLSL shader patterns",
      description: "Named GLSL shader techniques with ready-to-use fragment shader snippets.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const name = firstVar(variables.pattern_name);
      const pattern = ctx.knowledge.getGlslPattern(name);
      if (!pattern) return jsonContents(uri, { error: `GLSL pattern "${name}" not found.` });
      return jsonContents(uri, pattern);
    },
  );
};
