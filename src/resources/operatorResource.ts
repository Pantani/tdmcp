import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { compactKey } from "../knowledge/normalize.js";
import { firstVar, jsonContents, type ResourceRegistrar } from "./shared.js";

export const registerOperatorResource: ResourceRegistrar = (server, ctx) => {
  const template = new ResourceTemplate("tdmcp://operators/{name}", {
    list: async () => ({
      resources: ctx.knowledge.listOperatorCategories().map((category) => ({
        uri: `tdmcp://operators/${category}`,
        name: `Operators: ${category}`,
        description: `All ${category} operators`,
        mimeType: "application/json",
      })),
    }),
    complete: {
      name: async (value) => {
        const categories = ctx.knowledge.listOperatorCategories();
        const operators = ctx.knowledge.searchOperators(value, 20).map((o) => o.slug);
        return [...categories, ...operators].slice(0, 50);
      },
    },
  });

  server.registerResource(
    "td-operators",
    template,
    {
      title: "TouchDesigner operators",
      description:
        "Operator catalog. Read a category (TOP, CHOP, SOP, DAT, COMP, MAT, POP) to list its operators, or an operator name/slug for full documentation.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const name = firstVar(variables.name);
      const isCategory = ctx.knowledge
        .listOperatorCategories()
        .some((category) => compactKey(category) === compactKey(name));

      if (isCategory) {
        const operators = ctx.knowledge.listOperators(name);
        return jsonContents(uri, { category: name, count: operators.length, operators });
      }

      const doc = ctx.knowledge.getOperator(name);
      if (!doc) {
        const suggestions = ctx.knowledge.searchOperators(name, 5).map((o) => o.name);
        return jsonContents(uri, { error: `Operator "${name}" not found.`, suggestions });
      }
      return jsonContents(uri, doc);
    },
  );
};
