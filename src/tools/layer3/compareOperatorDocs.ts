import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { OperatorDoc, OperatorParameter, OperatorSummary } from "../../knowledge/types.js";
import { errorResult, structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const compareOperatorDocsSchema = z.object({
  operator_a: z
    .string()
    .min(1)
    .describe("First TouchDesigner operator name, display name, or slug."),
  operator_b: z
    .string()
    .min(1)
    .describe("Second TouchDesigner operator name, display name, or slug."),
  include_parameters: z
    .boolean()
    .default(true)
    .describe("Include shared and unique parameter detail arrays in the structured result."),
  parameter_limit: z.coerce
    .number()
    .int()
    .positive()
    .max(100)
    .default(30)
    .describe("Maximum parameter entries to return in each shared/unique parameter list."),
});
type CompareOperatorDocsInput = z.input<typeof compareOperatorDocsSchema>;
type CompareOperatorDocsArgs = z.output<typeof compareOperatorDocsSchema>;

const operatorOverviewSchema = z.object({
  input: z.string().describe("The operator string from the request."),
  name: z.string().describe("Resolved operator name."),
  displayName: z.string().describe("Resolved display name."),
  category: z.string().optional().describe("Operator family, e.g. TOP, CHOP, SOP, DAT."),
  subcategory: z.string().optional().describe("Operator subcategory from the embedded docs."),
  summary: z.string().optional().describe("Short embedded summary."),
  description: z.string().optional().describe("Longer embedded description, when available."),
});

const parameterSummarySchema = z.object({
  name: z.string().describe("Parameter name from the embedded docs."),
  label: z.string().optional().describe("Parameter label, when documented."),
  type: z.string().optional().describe("Parameter type or data type, when documented."),
  description: z.string().optional().describe("Parameter description, when documented."),
});

const sharedParameterSchema = parameterSummarySchema.extend({
  operatorA: parameterSummarySchema.describe("Parameter metadata on operator_a."),
  operatorB: parameterSummarySchema.describe("Parameter metadata on operator_b."),
});

export const compareOperatorDocsOutputSchema = z.object({
  operatorA: operatorOverviewSchema.describe("Resolved first operator."),
  operatorB: operatorOverviewSchema.describe("Resolved second operator."),
  overview: z
    .object({
      sameCategory: z.boolean().describe("True when both operators share the same category."),
      sameSubcategory: z.boolean().describe("True when both operators share the same subcategory."),
      categoryA: z.string().optional().describe("Category of operator_a."),
      categoryB: z.string().optional().describe("Category of operator_b."),
      subcategoryA: z.string().optional().describe("Subcategory of operator_a."),
      subcategoryB: z.string().optional().describe("Subcategory of operator_b."),
      parameterCountA: z
        .number()
        .int()
        .nonnegative()
        .describe("Documented parameter count for operator_a."),
      parameterCountB: z
        .number()
        .int()
        .nonnegative()
        .describe("Documented parameter count for operator_b."),
      summaryA: z.string().optional().describe("Short summary of operator_a."),
      summaryB: z.string().optional().describe("Short summary of operator_b."),
    })
    .describe("High-level comparison of the two operator documents."),
  sharedParameters: z
    .array(sharedParameterSchema)
    .describe("Parameters present on both operators by compact normalized name."),
  uniqueToA: z.array(parameterSummarySchema).describe("Parameters only present on operator_a."),
  uniqueToB: z.array(parameterSummarySchema).describe("Parameters only present on operator_b."),
  summary: z
    .object({
      sharedParameterCount: z.number().int().nonnegative(),
      sharedCount: z.number().int().nonnegative(),
      uniqueToACount: z.number().int().nonnegative(),
      uniqueToBCount: z.number().int().nonnegative(),
      returnedSharedParameterCount: z.number().int().nonnegative(),
      returnedUniqueToACount: z.number().int().nonnegative(),
      returnedUniqueToBCount: z.number().int().nonnegative(),
      parametersIncluded: z.boolean(),
      parameterLimit: z.number().int().positive(),
    })
    .describe("Counts before and after applying include_parameters / parameter_limit."),
});

type OperatorOverview = z.output<typeof operatorOverviewSchema>;
type ParameterSummary = z.output<typeof parameterSummarySchema>;
type SharedParameter = z.output<typeof sharedParameterSchema>;

interface ParameterComparison {
  shared: SharedParameter[];
  uniqueToA: ParameterSummary[];
  uniqueToB: ParameterSummary[];
}

interface MissingOperator {
  field: "operator_a" | "operator_b";
  input: string;
  suggestions: OperatorSummary[];
}

type ResolvedOperators =
  | { ok: true; docA: OperatorDoc; docB: OperatorDoc }
  | { ok: false; result: CallToolResult };

function compactKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function parameterKey(parameter: OperatorParameter): string {
  return compactKey(parameter.name);
}

function parameterMap(parameters: OperatorParameter[]): Map<string, OperatorParameter> {
  const map = new Map<string, OperatorParameter>();
  for (const parameter of parameters) {
    const key = parameterKey(parameter);
    if (key && !map.has(key)) map.set(key, parameter);
  }
  return map;
}

function parameterType(parameter: OperatorParameter): string | undefined {
  return parameter.type ?? parameter.dataType;
}

function parameterSummary(parameter: OperatorParameter): ParameterSummary {
  const summary: ParameterSummary = { name: parameter.name };
  if (parameter.label) summary.label = parameter.label;
  const type = parameterType(parameter);
  if (type) summary.type = type;
  if (parameter.description) summary.description = parameter.description;
  return summary;
}

function sharedParameterSummary(
  parameterA: OperatorParameter,
  parameterB: OperatorParameter,
): SharedParameter {
  return {
    ...parameterSummary(parameterA),
    description: parameterA.description ?? parameterB.description,
    operatorA: parameterSummary(parameterA),
    operatorB: parameterSummary(parameterB),
  };
}

function compareParameters(docA: OperatorDoc, docB: OperatorDoc): ParameterComparison {
  const parametersA = docA.parameters ?? [];
  const parametersB = docB.parameters ?? [];
  const mapB = parameterMap(parametersB);
  const seenShared = new Set<string>();
  const shared: SharedParameter[] = [];
  const uniqueToA: ParameterSummary[] = [];

  for (const parameter of parametersA) {
    const key = parameterKey(parameter);
    if (!key) continue;
    const matchingB = mapB.get(key);
    if (matchingB) {
      if (!seenShared.has(key)) {
        shared.push(sharedParameterSummary(parameter, matchingB));
        seenShared.add(key);
      }
    } else {
      uniqueToA.push(parameterSummary(parameter));
    }
  }

  const mapA = parameterMap(parametersA);
  const uniqueToB = parametersB
    .filter((parameter) => {
      const key = parameterKey(parameter);
      return key && !mapA.has(key);
    })
    .map(parameterSummary);

  return { shared, uniqueToA, uniqueToB };
}

function operatorOverview(input: string, doc: OperatorDoc): OperatorOverview {
  const overview: OperatorOverview = {
    input,
    name: doc.name,
    displayName: doc.displayName ?? doc.name,
  };
  if (doc.category) overview.category = doc.category;
  if (doc.subcategory) overview.subcategory = doc.subcategory;
  if (doc.summary) overview.summary = doc.summary;
  if (doc.description) overview.description = doc.description;
  return overview;
}

function comparisonOverview(docA: OperatorDoc, docB: OperatorDoc) {
  return {
    sameCategory:
      docA.category && docB.category
        ? compactKey(docA.category) === compactKey(docB.category)
        : false,
    sameSubcategory:
      docA.subcategory && docB.subcategory
        ? compactKey(docA.subcategory) === compactKey(docB.subcategory)
        : false,
    categoryA: docA.category,
    categoryB: docB.category,
    subcategoryA: docA.subcategory,
    subcategoryB: docB.subcategory,
    parameterCountA: docA.parameters?.length ?? 0,
    parameterCountB: docB.parameters?.length ?? 0,
    summaryA: docA.summary ?? docA.description,
    summaryB: docB.summary ?? docB.description,
  };
}

function missingOperator(
  ctx: ToolContext,
  field: MissingOperator["field"],
  input: string,
): MissingOperator {
  return {
    field,
    input,
    suggestions: ctx.knowledge.searchOperators(input, 5),
  };
}

function missingOperatorsResult(
  ctx: ToolContext,
  args: CompareOperatorDocsArgs,
): ResolvedOperators {
  const missing: MissingOperator[] = [];
  const docA = ctx.knowledge.getOperator(args.operator_a);
  const docB = ctx.knowledge.getOperator(args.operator_b);

  if (!docA) missing.push(missingOperator(ctx, "operator_a", args.operator_a));
  if (!docB) missing.push(missingOperator(ctx, "operator_b", args.operator_b));
  if (docA && docB) return { ok: true, docA, docB };

  const names = missing.map((entry) => `"${entry.input}"`).join(", ");
  return {
    ok: false,
    result: errorResult(`Operator not found for compare_operator_docs: ${names}.`, { missing }),
  };
}

export function compareOperatorDocsImpl(
  ctx: ToolContext,
  rawArgs: CompareOperatorDocsInput,
): CallToolResult {
  const parsed = compareOperatorDocsSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return errorResult("Invalid compare_operator_docs input.", { issues: parsed.error.issues });
  }

  const args = parsed.data;
  try {
    const resolved = missingOperatorsResult(ctx, args);
    if (!resolved.ok) return resolved.result;

    const { docA, docB } = resolved;
    const comparison = compareParameters(docA, docB);
    const sharedParameters = args.include_parameters
      ? comparison.shared.slice(0, args.parameter_limit)
      : [];
    const uniqueToA = args.include_parameters
      ? comparison.uniqueToA.slice(0, args.parameter_limit)
      : [];
    const uniqueToB = args.include_parameters
      ? comparison.uniqueToB.slice(0, args.parameter_limit)
      : [];
    const operatorA = operatorOverview(args.operator_a, docA);
    const operatorB = operatorOverview(args.operator_b, docB);
    const summary = {
      sharedParameterCount: comparison.shared.length,
      sharedCount: comparison.shared.length,
      uniqueToACount: comparison.uniqueToA.length,
      uniqueToBCount: comparison.uniqueToB.length,
      returnedSharedParameterCount: sharedParameters.length,
      returnedUniqueToACount: uniqueToA.length,
      returnedUniqueToBCount: uniqueToB.length,
      parametersIncluded: args.include_parameters,
      parameterLimit: args.parameter_limit,
    };

    return structuredResult(
      `Compared ${operatorA.name} vs ${operatorB.name}: ${summary.sharedParameterCount} shared parameters, ${summary.uniqueToACount} unique to ${operatorA.name}, ${summary.uniqueToBCount} unique to ${operatorB.name}.`,
      {
        operatorA,
        operatorB,
        overview: comparisonOverview(docA, docB),
        sharedParameters,
        uniqueToA,
        uniqueToB,
        summary,
      },
    );
  } catch (err) {
    return errorResult("Failed to compare operator docs.", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export const registerCompareOperatorDocs: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "compare_operator_docs",
    {
      title: "Compare operator docs",
      description:
        "Read-only: compare two TouchDesigner operator types from the embedded offline knowledge base, including overview metadata plus shared and unique documented parameters. This compares operator documentation, not live node settings; use compare_td_nodes for live node parameter diffs.",
      inputSchema: compareOperatorDocsSchema.shape,
      outputSchema: compareOperatorDocsOutputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    (args) => compareOperatorDocsImpl(ctx, args),
  );
};
