import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { errorResult } from "./result.js";
import type { ToolContext } from "./types.js";

interface RecipeCodeInputs {
  parameters?: readonly { expr?: unknown }[];
  python_code?: Readonly<Record<string, unknown>>;
}

/** Whether caller-supplied Python/code-bearing text may cross into TouchDesigner. */
export function allowsCallerCode(ctx: Pick<ToolContext, "allowRawPython">): boolean {
  return ctx.allowRawPython !== false;
}

/** Stable friendly denial used before any bridge request. */
export function callerCodeDenied(action: string): CallToolResult {
  return errorResult(
    `${action} is unavailable because raw Python is disabled (TDMCP_RAW_PYTHON=off). ` +
      "Enable it only for trusted caller-supplied code and keep " +
      "TDMCP_BRIDGE_ALLOW_EXEC=1 as the independent bridge authorization.",
  );
}

/** Code-bearing recipe fields that must not run under the restricted policy. */
export function recipeCodeBearingSources(recipe: RecipeCodeInputs): string[] {
  const sources: string[] = [];
  if (recipe.parameters?.some((param) => typeof param.expr === "string")) {
    sources.push("parameter expressions");
  }
  if (recipe.python_code && Object.keys(recipe.python_code).length > 0) {
    sources.push("python_code");
  }
  return sources;
}
