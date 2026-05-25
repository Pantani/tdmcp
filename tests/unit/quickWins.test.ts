import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { describeProjectImpl } from "../../src/tools/layer1/describeProject.js";
import { getModuleHelpImpl } from "../../src/tools/layer3/getModuleHelp.js";
import { getTdClassDetailsImpl } from "../../src/tools/layer3/getTdClassDetails.js";
import { getTdClassesImpl } from "../../src/tools/layer3/getTdClasses.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

const ctx: ToolContext = {
  client: new TouchDesignerClient({
    baseUrl: "http://127.0.0.1:1",
    timeoutMs: 500,
    logger: silentLogger,
  }),
  knowledge: new KnowledgeBase(),
  recipes: new RecipeLibrary(),
  logger: silentLogger,
};

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

describe("quick-win offline tools", () => {
  it("get_td_classes lists classes and filters by name", () => {
    expect(textOf(getTdClassesImpl(ctx, {}))).toContain("Python API class");
    const filtered = getTdClassesImpl(ctx, { filter: "op" });
    expect(filtered.isError).toBeFalsy();
  });

  it("get_td_class_details returns a known class or suggestions", () => {
    const result = getTdClassDetailsImpl(ctx, { class_name: "App" });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("App");
  });

  it("get_module_help returns formatted help for a known class", () => {
    expect(textOf(getModuleHelpImpl(ctx, { name: "App" })).length).toBeGreaterThan(10);
  });

  it("describe_project classifies a feedback description", () => {
    expect(
      textOf(describeProjectImpl(ctx, { description: "a feedback tunnel from noise" })),
    ).toContain("create_feedback_network");
  });

  it("describe_project maps reaction-diffusion to its recipe", () => {
    expect(
      textOf(describeProjectImpl(ctx, { description: "a reaction diffusion simulation" })),
    ).toContain("reaction_diffusion");
  });
});
