/** @type {import("dependency-cruiser").IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular-dependencies",
      severity: "error",
      comment: "Modules under src must not form circular dependency chains.",
      from: {
        path: "^src/",
      },
      to: {
        circular: true,
      },
    },
    {
      name: "tools-layer2-must-not-import-layer1",
      severity: "error",
      comment:
        "Layer 2 is a lower-level building-block layer and must not depend on Layer 1 artist tools.",
      from: {
        path: "^src/tools/layer2/",
      },
      to: {
        path: "^src/tools/layer1/",
      },
    },
    {
      name: "tools-layer3-must-not-import-higher-tool-layers",
      severity: "error",
      comment: "Layer 3 is the atomic tool layer and must not depend on Layer 1 or Layer 2 tools.",
      from: {
        path: "^src/tools/layer3/",
      },
      to: {
        path: ["^src/tools/layer1/", "^src/tools/layer2/"],
      },
    },
    {
      name: "runtime-modules-must-not-import-cli",
      severity: "error",
      comment: "Reusable runtime modules must stay independent from the CLI adapter layer.",
      from: {
        path: [
          "^src/automation/",
          "^src/feedback/",
          "^src/integrations/",
          "^src/knowledge/",
          "^src/llm/",
          "^src/prompts/",
          "^src/recipes/",
          "^src/resources/",
          "^src/server/",
          "^src/td-client/",
          "^src/tools/",
          "^src/utils/",
          "^src/vault/",
        ],
      },
      to: {
        path: "^src/cli/",
      },
    },
    {
      name: "runtime-modules-must-not-import-server-composition",
      severity: "error",
      comment:
        "Reusable runtime modules must not import server composition code; src/server wires them together.",
      from: {
        path: [
          "^src/automation/",
          "^src/feedback/",
          "^src/integrations/",
          "^src/knowledge/",
          "^src/llm/",
          "^src/prompts/",
          "^src/recipes/",
          "^src/resources/",
          "^src/td-client/",
          "^src/tools/",
          "^src/utils/",
          "^src/vault/",
        ],
      },
      to: {
        path: "^src/server/",
      },
    },
    {
      name: "td-client-must-stay-low-level",
      severity: "error",
      comment:
        "The TouchDesigner HTTP client is a low-level integration module and must not depend on higher application surfaces.",
      from: {
        path: "^src/td-client/",
      },
      to: {
        path: [
          "^src/automation/",
          "^src/cli/",
          "^src/feedback/",
          "^src/integrations/",
          "^src/knowledge/",
          "^src/llm/",
          "^src/packages/",
          "^src/prompts/",
          "^src/recipes/",
          "^src/resources/",
          "^src/server/",
          "^src/tools/",
          "^src/vault/",
        ],
      },
    },
  ],
  options: {
    doNotFollow: {
      path: ["node_modules"],
    },
    tsPreCompilationDeps: false,
    tsConfig: {
      fileName: "tsconfig.json",
    },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".json"],
      mainFields: ["module", "main", "types", "typings"],
    },
    skipAnalysisNotInRules: true,
    reporterOptions: {
      dot: {
        collapsePattern: "node_modules/(?:@[^/]+/[^/]+|[^/]+)",
      },
    },
  },
};
