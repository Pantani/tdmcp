import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { errorResult } from "./result.js";
import type { ToolContext } from "./types.js";

interface RecipeCodeInputs {
  nodes?: readonly {
    name?: unknown;
    type?: unknown;
    parameters?: Readonly<Record<string, unknown>>;
  }[];
  parameters?: readonly { expr?: unknown }[];
  python_code?: Readonly<Record<string, unknown>>;
  glsl_code?: Readonly<Record<string, unknown>>;
}

type GenericNodeParameters = Readonly<Record<string, unknown>> | undefined;

const EXECUTABLE_OPERATOR_FRAGMENTS = [
  "script",
  "execute",
  "expression",
  "evaluate",
  "glsl",
  "shaderpark",
] as const;
const CODE_PARAMETER_FRAGMENTS = ["callback", "python", "script", "glsl", "shader"] as const;
const CODE_PARAMETER_NAMES = new Set(["code", "expr", "expression", "bindexpr"]);
const TYPE_SPECIFIC_CODE_PARAMETERS: Readonly<Record<string, ReadonlySet<string>>> = {
  groupsop: new Set(["filter"]),
  deletesop: new Set(["filter"]),
  grouppop: new Set(["filter"]),
  deletepop: new Set(["filter"]),
  textcomp: new Set(["customformatting"]),
};
const DAT_FILE_PARAMETER_NAMES = new Set(["file", "syncfile", "loadonstart", "loadonstartpulse"]);

function normalizedIdentifier(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase().replace(/[^a-z0-9]/g, "") : "";
}

function isCodeBearingParameter(normalizedType: string, normalizedName: string): boolean {
  if (CODE_PARAMETER_NAMES.has(normalizedName)) return true;
  if (normalizedName.endsWith("expr")) return true;
  if (/^ext\d+object$/.test(normalizedName)) return true;
  if (CODE_PARAMETER_FRAGMENTS.some((fragment) => normalizedName.startsWith(fragment))) {
    return true;
  }
  return TYPE_SPECIFIC_CODE_PARAMETERS[normalizedType]?.has(normalizedName) === true;
}

/** Whether caller-supplied Python/code-bearing text may cross into TouchDesigner. */
export function allowsCallerCode(
  ctx: Pick<ToolContext, "allowRawPython" | "toolProfile">,
): boolean {
  return (
    ctx.allowRawPython !== false && ctx.toolProfile !== "safe" && ctx.toolProfile !== "directory"
  );
}

/** Stable friendly denial used before any bridge request. */
export function callerCodeDenied(action: string): CallToolResult {
  return errorResult(
    `${action} is unavailable because raw Python is disabled or the active tool profile ` +
      "forbids caller-supplied code (TDMCP_RAW_PYTHON=off; " +
      "TDMCP_TOOL_PROFILE=safe/directory). " +
      "Enable it only for trusted caller-supplied code and keep " +
      "TDMCP_BRIDGE_ALLOW_EXEC=1 as the independent bridge authorization.",
  );
}

/**
 * Detect executable operator types and parameters accepted by generic create/update tools.
 * These primitives must fail closed in raw-off mode because they otherwise bypass the
 * dedicated DAT/GLSL/script tools' caller-code checks.
 */
export function genericNodeCodeBearingSources(
  type: unknown,
  parameters?: GenericNodeParameters,
): string[] {
  const sources: string[] = [];
  const normalizedType = normalizedIdentifier(type);
  if (EXECUTABLE_OPERATOR_FRAGMENTS.some((fragment) => normalizedType.includes(fragment))) {
    sources.push(`operator type ${String(type)}`);
  }

  for (const name of Object.keys(parameters ?? {})) {
    const normalizedName = normalizedIdentifier(name);
    const isCodeParameter = isCodeBearingParameter(normalizedType, normalizedName);
    const isDatFileSource =
      normalizedType.endsWith("dat") && DAT_FILE_PARAMETER_NAMES.has(normalizedName);
    if (isCodeParameter || isDatFileSource) {
      sources.push(`parameter ${name}`);
    }
  }

  return [...new Set(sources)];
}

function recipeNodeCodeBearingSources(
  node: NonNullable<RecipeCodeInputs["nodes"]>[number],
): string[] {
  const label = typeof node.name === "string" ? ` on ${node.name}` : "";
  return genericNodeCodeBearingSources(node.type, node.parameters).map(
    (source) => `${source}${label}`,
  );
}

/** Code-bearing recipe fields that must not run under the restricted policy. */
export function recipeCodeBearingSources(recipe: RecipeCodeInputs): string[] {
  const sources = (recipe.nodes ?? []).flatMap(recipeNodeCodeBearingSources);
  if (recipe.parameters?.some((param) => typeof param.expr === "string")) {
    sources.push("parameter expressions");
  }
  if (recipe.python_code && Object.keys(recipe.python_code).length > 0) {
    sources.push("python_code");
  }
  if (recipe.glsl_code && Object.keys(recipe.glsl_code).length > 0) {
    sources.push("glsl_code");
  }
  return sources;
}
