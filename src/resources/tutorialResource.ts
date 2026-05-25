import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { firstVar, jsonContents, type ResourceRegistrar } from "./shared.js";

export const registerTutorialResource: ResourceRegistrar = (server, ctx) => {
  const template = new ResourceTemplate("tdmcp://tutorials/{tutorial_name}", {
    list: async () => ({
      resources: ctx.knowledge.listTutorials().map((tutorial) => ({
        uri: `tdmcp://tutorials/${tutorial.id}`,
        name: tutorial.name,
        description: tutorial.summary,
        mimeType: "application/json",
      })),
    }),
  });

  server.registerResource(
    "td-tutorials",
    template,
    {
      title: "TouchDesigner tutorials",
      description: "Long-form tutorial content covering TD fundamentals and workflows.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const name = firstVar(variables.tutorial_name);
      const tutorial = ctx.knowledge.getTutorial(name);
      if (!tutorial) return jsonContents(uri, { error: `Tutorial "${name}" not found.` });
      return jsonContents(uri, tutorial);
    },
  );
};
