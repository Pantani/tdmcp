import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { firstVar, jsonContents, type ResourceRegistrar } from "./shared.js";

export const registerPythonApiResource: ResourceRegistrar = (server, ctx) => {
  const template = new ResourceTemplate("tdmcp://python-api/{class_name}", {
    list: async () => ({
      resources: ctx.knowledge.listPythonClasses().map((cls) => ({
        uri: `tdmcp://python-api/${cls.className}`,
        name: `Python: ${cls.className}`,
        description: `${cls.methodCount} methods, ${cls.memberCount} members`,
        mimeType: "application/json",
      })),
    }),
    complete: {
      class_name: async (value) =>
        ctx.knowledge
          .listPythonClasses()
          .map((c) => c.className)
          .filter((n) => n.toLowerCase().includes(value.toLowerCase()))
          .slice(0, 50),
    },
  });

  server.registerResource(
    "td-python-api",
    template,
    {
      title: "TouchDesigner Python API",
      description: "Python class reference (members + methods) for the TouchDesigner API.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const className = firstVar(variables.class_name);
      const cls = ctx.knowledge.getPythonClass(className);
      if (!cls) return jsonContents(uri, { error: `Python class "${className}" not found.` });
      return jsonContents(uri, cls);
    },
  );
};
