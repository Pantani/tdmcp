import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { firstVar, jsonContents, type ResourceRegistrar } from "./shared.js";

export const registerPatternResource: ResourceRegistrar = (server, ctx) => {
  const template = new ResourceTemplate("tdmcp://patterns/{pattern_name}", {
    list: async () => ({
      resources: ctx.knowledge.listPatterns().map((pattern) => ({
        uri: `tdmcp://patterns/${pattern.id}`,
        name: pattern.name,
        description: pattern.description,
        mimeType: "application/json",
      })),
    }),
  });

  server.registerResource(
    "td-patterns",
    template,
    {
      title: "TouchDesigner workflow patterns",
      description: "Named operator-chain workflow patterns (recommended wiring for common tasks).",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const name = firstVar(variables.pattern_name);
      const pattern = ctx.knowledge.getPattern(name);
      if (!pattern) return jsonContents(uri, { error: `Pattern "${name}" not found.` });
      return jsonContents(uri, pattern);
    },
  );
};
