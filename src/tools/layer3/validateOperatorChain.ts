import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type {
  OperatorConnectionEntry,
  OperatorConnectionsGuide,
  OperatorDoc,
  OperatorSummary,
} from "../../knowledge/types.js";
import { errorResult, structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const validateOperatorChainSchema = z.object({
  chain: z
    .array(z.string().trim().min(1))
    .min(1)
    .describe("Ordered TouchDesigner operator names, display names, or slugs to validate."),
  family: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Optional expected operator family/category, e.g. TOP, CHOP, SOP, DAT, or POP."),
  category: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Alias for family; optional expected operator category."),
  target_version: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Optional target TouchDesigner stable version, e.g. 099, 2023, or 2024."),
  require_documented_connections: z
    .boolean()
    .default(false)
    .describe("When true, adjacent pairs must be documented by embedded connection guides."),
});
type ValidateOperatorChainInput = z.input<typeof validateOperatorChainSchema>;
type ValidateOperatorChainArgs = z.output<typeof validateOperatorChainSchema>;

const severitySchema = z.enum(["ok", "warning", "error"]);
const issueSeveritySchema = z.enum(["warning", "error"]);
const issueTypeSchema = z.enum([
  "missing_operator",
  "family_mismatch",
  "undocumented_connection",
  "version_incompatible",
]);

const normalizedOperatorSchema = z.object({
  input: z.string(),
  operator: z.string(),
  displayName: z.string().optional(),
  category: z.string().optional(),
  subcategory: z.string().optional(),
  slug: z.string().optional(),
  found: z.boolean(),
  summary: z.string().optional(),
});

const issueSchema = z.object({
  type: issueTypeSchema,
  severity: issueSeveritySchema,
  message: z.string(),
  index: z.number().int().nonnegative().optional(),
  operator: z.string().optional(),
  expectedFamily: z.string().optional(),
  actualFamily: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  addedIn: z.string().optional(),
  targetVersion: z.string().optional(),
  suggestions: z.array(z.string()).optional(),
});

const connectionCheckSchema = z.object({
  from: z.string(),
  to: z.string(),
  fromIndex: z.number().int().nonnegative(),
  toIndex: z.number().int().nonnegative(),
  documented: z.boolean(),
  source: z.enum(["common_output", "common_input", "workflow", "none", "unresolved_operator"]),
  port: z.string().optional(),
  portHint: z.string().optional(),
  reason: z.string().optional(),
});

export const validateOperatorChainOutputSchema = z.object({
  valid: z.boolean(),
  severity: severitySchema,
  normalizedChain: z.array(normalizedOperatorSchema),
  issues: z.array(issueSchema),
  warnings: z.array(z.string()),
  connectionChecks: z.array(connectionCheckSchema),
  suggestions: z.array(z.string()),
  nextToolHints: z.array(z.string()),
});

type NormalizedOperator = z.output<typeof normalizedOperatorSchema>;
type ValidationIssue = z.output<typeof issueSchema>;
type ConnectionCheck = z.output<typeof connectionCheckSchema>;

interface ResolvedOperator extends NormalizedOperator {
  index: number;
  doc?: OperatorDoc;
  guide?: OperatorConnectionsGuide;
  searchSuggestions: string[];
}

interface DocumentedConnection {
  documented: boolean;
  source: ConnectionCheck["source"];
  port?: string;
  reason?: string;
}

function compactKey(value: string | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function slugish(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function requestedFamily(args: ValidateOperatorChainArgs): string | undefined {
  return args.family ?? args.category;
}

function candidateNames(summary: OperatorSummary): string[] {
  return uniqueStrings([summary.displayName, summary.name, summary.slug]);
}

function displayNameFor(doc: OperatorDoc, fallback: string): string {
  return doc.displayName ?? doc.name ?? fallback;
}

function resolvedAliases(operator: ResolvedOperator): string[] {
  const aliases = [
    operator.input,
    operator.operator,
    operator.displayName,
    operator.slug,
    operator.category ? `${operator.operator} ${operator.category}` : undefined,
  ];
  if (operator.category) {
    aliases.push(operator.operator.replace(new RegExp(`\\s+${operator.category}$`, "i"), ""));
    if (operator.displayName) {
      aliases.push(operator.displayName.replace(new RegExp(`\\s+${operator.category}$`, "i"), ""));
    }
  }
  return uniqueStrings(aliases.filter((alias): alias is string => Boolean(alias)));
}

function entryMatchesOperator(entryOperator: string, operator: ResolvedOperator): boolean {
  const entryKeys = [entryOperator];
  if (operator.category) entryKeys.push(`${entryOperator} ${operator.category}`);
  const aliases = resolvedAliases(operator).map(compactKey);
  return entryKeys.map(compactKey).some((key) => aliases.includes(key));
}

function findConnectionEntry(
  entries: OperatorConnectionEntry[],
  operator: ResolvedOperator,
): OperatorConnectionEntry | undefined {
  return entries.find((entry) => entryMatchesOperator(entry.op, operator));
}

function resolveOperator(ctx: ToolContext, input: string, index: number): ResolvedOperator {
  const doc = ctx.knowledge.getOperator(input);
  if (!doc) {
    const searchSuggestions = ctx.knowledge
      .searchOperators(input, 5)
      .flatMap(candidateNames)
      .slice(0, 5);
    return {
      input,
      operator: input,
      found: false,
      searchSuggestions,
      index,
    };
  }

  const guide = ctx.knowledge.getOperatorConnections(input);
  const displayName = displayNameFor(doc, input);
  return {
    input,
    operator: displayName,
    displayName,
    category: doc.category,
    subcategory: doc.subcategory,
    slug: guide?.operator.slug ?? slugish(displayName),
    found: true,
    summary: doc.summary ?? doc.description,
    doc,
    guide,
    searchSuggestions: [],
    index,
  };
}

function missingOperatorIssue(operator: ResolvedOperator): ValidationIssue {
  const suggestions =
    operator.searchSuggestions.length > 0 ? uniqueStrings(operator.searchSuggestions) : undefined;
  return {
    type: "missing_operator",
    severity: "error",
    message: `Operator "${operator.input}" could not be resolved from the embedded knowledge base.`,
    index: operator.index,
    operator: operator.input,
    suggestions,
  };
}

function familyMismatchIssue(
  operator: ResolvedOperator,
  family: string,
): ValidationIssue | undefined {
  if (!operator.found || !operator.category) return undefined;
  if (compactKey(operator.category) === compactKey(family)) return undefined;
  return {
    type: "family_mismatch",
    severity: "error",
    message: `${operator.operator} is ${operator.category}, not requested family/category ${family}.`,
    index: operator.index,
    operator: operator.operator,
    expectedFamily: family,
    actualFamily: operator.category,
  };
}

function versionIndex(ctx: ToolContext, version: string | undefined): number {
  if (!version) return -1;
  return ctx.knowledge.listTdVersions().findIndex((entry) => entry.id === version);
}

function numericVersion(value: string | undefined): number | undefined {
  const token = value?.match(/\b(099|99|20\d{2})\b/)?.[1];
  if (!token) return undefined;
  return token === "099" || token === "99" ? 99 : Number(token);
}

function isAfterTargetVersion(ctx: ToolContext, addedIn: string, targetVersion: string): boolean {
  const addedIndex = versionIndex(ctx, addedIn);
  const targetIndex = versionIndex(ctx, targetVersion);
  if (addedIndex !== -1 && targetIndex !== -1) return addedIndex > targetIndex;

  const addedNumeric = numericVersion(addedIn);
  const targetNumeric = numericVersion(targetVersion);
  return addedNumeric !== undefined && targetNumeric !== undefined && addedNumeric > targetNumeric;
}

function versionIssue(
  ctx: ToolContext,
  operator: ResolvedOperator,
  targetVersion: string | undefined,
): ValidationIssue | undefined {
  if (!operator.found || !targetVersion) return undefined;
  const compatibility = ctx.knowledge.getOperatorCompatibility(operator.slug ?? operator.operator);
  if (!compatibility?.addedIn) return undefined;
  if (!isAfterTargetVersion(ctx, compatibility.addedIn, targetVersion)) return undefined;
  return {
    type: "version_incompatible",
    severity: "error",
    message: `${operator.operator} was added in TouchDesigner ${compatibility.addedIn}, after target version ${targetVersion}.`,
    index: operator.index,
    operator: operator.operator,
    addedIn: compatibility.addedIn,
    targetVersion,
  };
}

function workflowReason(
  from: ResolvedOperator,
  to: ResolvedOperator,
): DocumentedConnection | undefined {
  const fromHit = from.guide?.workflowHits.find(
    (hit) => hit.nextOperator && entryMatchesOperator(hit.nextOperator, to),
  );
  if (fromHit) {
    return {
      documented: true,
      source: "workflow",
      reason: `Adjacent in ${fromHit.patternName}.`,
    };
  }

  const toHit = to.guide?.workflowHits.find(
    (hit) => hit.previousOperator && entryMatchesOperator(hit.previousOperator, from),
  );
  if (!toHit) return undefined;
  return {
    documented: true,
    source: "workflow",
    reason: `Adjacent in ${toHit.patternName}.`,
  };
}

function documentedConnection(from: ResolvedOperator, to: ResolvedOperator): DocumentedConnection {
  if (!from.found || !to.found) {
    return { documented: false, source: "unresolved_operator" };
  }

  const output = from.guide ? findConnectionEntry(from.guide.outputs, to) : undefined;
  if (output) {
    return {
      documented: true,
      source: "common_output",
      port: output.port,
      reason: output.reason,
    };
  }

  const input = to.guide ? findConnectionEntry(to.guide.inputs, from) : undefined;
  if (input) {
    return {
      documented: true,
      source: "common_input",
      port: input.port,
      reason: input.reason,
    };
  }

  return workflowReason(from, to) ?? { documented: false, source: "none" };
}

function connectionCheck(from: ResolvedOperator, to: ResolvedOperator): ConnectionCheck {
  const connection = documentedConnection(from, to);
  return {
    from: from.operator,
    to: to.operator,
    fromIndex: from.index,
    toIndex: to.index,
    documented: connection.documented,
    source: connection.source,
    port: connection.port,
    portHint: connection.port,
    reason: connection.reason,
  };
}

function undocumentedIssue(check: ConnectionCheck): ValidationIssue {
  return {
    type: "undocumented_connection",
    severity: "error",
    message: `No documented connection was found from ${check.from} to ${check.to}.`,
    from: check.from,
    to: check.to,
  };
}

function normalizedOnly(operator: ResolvedOperator): NormalizedOperator {
  return {
    input: operator.input,
    operator: operator.operator,
    displayName: operator.displayName,
    category: operator.category,
    subcategory: operator.subcategory,
    slug: operator.slug,
    found: operator.found,
    summary: operator.summary,
  };
}

function issueSuggestions(issues: ValidationIssue[]): string[] {
  const suggestions: string[] = [];
  for (const issue of issues) {
    if (issue.type === "missing_operator" && issue.operator) {
      const candidates = issue.suggestions?.length
        ? ` Candidates: ${issue.suggestions.join(", ")}.`
        : "";
      suggestions.push(`Run search_operators for "${issue.operator}".${candidates}`);
    }
    if (issue.type === "family_mismatch" && issue.operator && issue.expectedFamily) {
      suggestions.push(
        `Replace "${issue.operator}" with a ${issue.expectedFamily} operator or remove the family/category filter.`,
      );
    }
    if (issue.type === "undocumented_connection" && issue.from && issue.to) {
      suggestions.push(
        `Review "${issue.from}" -> "${issue.to}" with get_operator_workflow_guide before wiring.`,
      );
    }
    if (issue.type === "version_incompatible" && issue.operator && issue.targetVersion) {
      suggestions.push(
        `Choose an operator available in TouchDesigner ${issue.targetVersion} or raise target_version.`,
      );
    }
  }
  return uniqueStrings(suggestions);
}

function toolHints(args: ValidateOperatorChainArgs, issues: ValidationIssue[]): string[] {
  const hints = ["search_operators", "get_operator_workflow_guide", "suggest_operator_chain"];
  if (!issues.some((issue) => issue.severity === "error")) {
    hints.push("draft_recipe_from_operator_chain");
  }
  if (args.target_version || issues.some((issue) => issue.type === "version_incompatible")) {
    hints.push("plan_td_version_migration");
  }
  return uniqueStrings(hints);
}

function severityFor(
  issues: ValidationIssue[],
  warnings: string[],
): z.output<typeof severitySchema> {
  if (issues.some((issue) => issue.severity === "error")) return "error";
  return warnings.length > 0 ? "warning" : "ok";
}

function resolvedTargetVersion(
  ctx: ToolContext,
  rawVersion: string | undefined,
): string | undefined {
  if (!rawVersion) return undefined;
  return ctx.knowledge.getTdVersion(rawVersion)?.id;
}

function connectionChecksFor(resolved: ResolvedOperator[]): ConnectionCheck[] {
  const checks: ConnectionCheck[] = [];
  for (let index = 0; index < resolved.length - 1; index += 1) {
    const from = resolved[index];
    const to = resolved[index + 1];
    if (!from || !to) continue;
    checks.push(connectionCheck(from, to));
  }
  return checks;
}

export function validateOperatorChainImpl(
  ctx: ToolContext,
  rawArgs: ValidateOperatorChainInput,
): CallToolResult {
  const parsed = validateOperatorChainSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return errorResult("Invalid validate_operator_chain input.", { issues: parsed.error.issues });
  }

  const args = parsed.data;
  try {
    const family = requestedFamily(args);
    const targetVersion = resolvedTargetVersion(ctx, args.target_version);
    const warnings: string[] = [];
    if (args.target_version && !targetVersion) {
      warnings.push(
        `Target TouchDesigner version "${args.target_version}" was not found in the embedded version manifest; version compatibility checks were skipped.`,
      );
    }

    const resolved = args.chain.map((operator, index) => resolveOperator(ctx, operator, index));
    const connectionChecks = connectionChecksFor(resolved);
    const issues: ValidationIssue[] = [];

    for (const operator of resolved) {
      if (!operator.found) {
        issues.push(missingOperatorIssue(operator));
        continue;
      }
      const familyIssue = familyMismatchIssue(operator, family ?? "");
      if (family && familyIssue) issues.push(familyIssue);
      const compatibilityIssue = versionIssue(ctx, operator, targetVersion);
      if (compatibilityIssue) issues.push(compatibilityIssue);
    }

    for (const check of connectionChecks) {
      if (check.source === "unresolved_operator") continue;
      if (check.documented) continue;
      if (args.require_documented_connections) {
        issues.push(undocumentedIssue(check));
      } else {
        warnings.push(`No documented connection was found from ${check.from} to ${check.to}.`);
      }
    }

    const severity = severityFor(issues, warnings);
    const valid = severity !== "error";
    const summary = valid
      ? `Validated operator chain: ${resolved.length} operator(s), ${warnings.length} warning(s).`
      : `Operator chain has ${issues.length} issue(s) and ${warnings.length} warning(s).`;
    return structuredResult(summary, {
      valid,
      severity,
      normalizedChain: resolved.map(normalizedOnly),
      issues,
      warnings,
      connectionChecks,
      suggestions: issueSuggestions(issues),
      nextToolHints: toolHints(args, issues),
    });
  } catch (err) {
    return errorResult("Failed to validate operator chain.", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export const registerValidateOperatorChain: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "validate_operator_chain",
    {
      title: "Validate operator chain",
      description:
        "Read-only: validate an ordered TouchDesigner operator chain against embedded operator docs, documented connections, family/category filters, and optional TouchDesigner version compatibility. It does not create or modify TD nodes.",
      inputSchema: validateOperatorChainSchema.shape,
      outputSchema: validateOperatorChainOutputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    (args) => validateOperatorChainImpl(ctx, args),
  );
};
