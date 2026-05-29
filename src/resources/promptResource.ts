import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PROMPT_CATALOG } from "../prompts/catalog.js";
import { firstVar, jsonContents, type ResourceRegistrar } from "./shared.js";

export const registerPromptResource: ResourceRegistrar = (server) => {
  const template = new ResourceTemplate("tdmcp://prompts/{prompt_name}", {
    list: async () => ({
      resources: PROMPT_CATALOG.map((prompt) => ({
        uri: `tdmcp://prompts/${prompt.name}`,
        name: prompt.title,
        description: prompt.description,
        mimeType: "application/json",
      })),
    }),
  });

  server.registerResource(
    "td-prompts",
    template,
    {
      title: "tdmcp prompts",
      description: "Catalog of MCP prompts shipped with tdmcp.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const name = firstVar(variables.prompt_name);
      const prompt = PROMPT_CATALOG.find((entry) => entry.name === name);
      if (!prompt) {
        return jsonContents(uri, {
          error: `Prompt "${name}" not found.`,
          available: PROMPT_CATALOG.map((entry) => entry.name),
        });
      }
      return jsonContents(uri, prompt);
    },
  );
};
