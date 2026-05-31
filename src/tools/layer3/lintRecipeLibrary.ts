import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { KnowledgeBase } from "../../knowledge/index.js";
import type { RecipeLibrary } from "../../recipes/loader.js";
import { type Recipe, RecipeSchema } from "../../recipes/schema.js";
import { recipesDir } from "../../utils/paths.js";
import { errorResult, structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const RULE_IDS = [
  "schema",
  "id_filename_match",
  "duplicate_node_names",
  "unknown_operator",
  "dangling_connection",
  "bad_parent",
  "render_outside_geo",
  "parameter_node_missing",
  "parameter_par_unknown",
  "control_bind_unresolved",
  "glsl_uniform_host",
  "tags_empty",
  "description_empty",
  "preview_description_empty",
] as const;
type RuleId = (typeof RULE_IDS)[number];

const RULE_SEVERITY: Record<RuleId, "error" | "warn" | "info"> = {
  schema: "error",
  id_filename_match: "warn",
  duplicate_node_names: "error",
  unknown_operator: "warn",
  dangling_connection: "error",
  bad_parent: "error",
  render_outside_geo: "error",
  parameter_node_missing: "error",
  parameter_par_unknown: "info",
  control_bind_unresolved: "error",
  glsl_uniform_host: "warn",
  tags_empty: "info",
  description_empty: "warn",
  preview_description_empty: "info",
};

export const lintRecipeLibrarySchema = z.object({
  recipe_id: z
    .string()
    .optional()
    .describe("If set, lint only this one recipe (matched by id); otherwise lint all."),
  severity: z
    .enum(["error", "warn", "info"])
    .default("warn")
    .describe("Minimum severity to include in the result."),
  rules: z
    .array(z.enum(RULE_IDS))
    .optional()
    .describe("Subset of rule ids to run; default runs every rule."),
  fail_on: z
    .enum(["error", "warn", "never"])
    .default("error")
    .describe("Severity at which the tool returns isError (CLI maps to exit code)."),
});
export type LintRecipeLibraryArgs = z.infer<typeof lintRecipeLibrarySchema>;

export interface Finding {
  rule: RuleId;
  path: string;
  message: string;
  hint?: string;
}

export interface RecipeReport {
  id: string;
  file: string;
  errors: Finding[];
  warnings: Finding[];
  info: Finding[];
}

export interface LintReport {
  summary: {
    totalRecipes: number;
    withErrors: number;
    withWarnings: number;
    rulesRun: RuleId[];
  };
  recipes: RecipeReport[];
}

interface LoadedRecipe {
  /** Parsed recipe (if schema valid). */
  recipe?: Recipe;
  /** Raw JSON payload (always present, even when schema-invalid). */
  raw: unknown;
  /** File name (e.g. "foo.json"), or synthetic for vault recipes. */
  file: string;
  /** Schema parse error, if any. */
  schemaError?: z.ZodError;
  /** Effective id (recipe id, else raw.id, else file basename). */
  id: string;
}

const SEVERITY_RANK: Record<"error" | "warn" | "info", number> = {
  error: 2,
  warn: 1,
  info: 0,
};

/** Load recipe sources for linting. Reads recipesDir JSON files directly so we
 * can see schema-invalid files too (RecipeLibrary silently drops those). */
export function loadRecipesForLint(opts: {
  dir?: string;
  recipes?: RecipeLibrary;
}): LoadedRecipe[] {
  const dir = opts.dir ?? recipesDir();
  const out: LoadedRecipe[] = [];
  if (existsSync(dir)) {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(join(dir, file), "utf8"));
      } catch (err) {
        out.push({
          raw: undefined,
          file,
          id: file.replace(/\.json$/, ""),
          schemaError: undefined,
          // signal a JSON parse error via a synthetic schema issue handled later
          recipe: undefined,
          // store message for the rule to pick up
        });
        // Synthesize a finding via schemaError-less branch using raw=undefined detection
        // We'll handle JSON parse via a custom Finding inside runLint.
        (out[out.length - 1] as LoadedRecipe & { parseError?: string }).parseError = String(err);
        continue;
      }
      const parsed = RecipeSchema.safeParse(raw);
      const fallbackId =
        (typeof (raw as { id?: unknown })?.id === "string"
          ? ((raw as { id: string }).id as string)
          : undefined) ?? file.replace(/\.json$/, "");
      out.push({
        recipe: parsed.success ? parsed.data : undefined,
        raw,
        file,
        schemaError: parsed.success ? undefined : parsed.error,
        id: parsed.success ? parsed.data.id : fallbackId,
      });
    }
  }
  return out;
}

function isCompType(type: string): boolean {
  return /COMP$/i.test(type);
}

function isGlslTopType(type: string): boolean {
  const t = type.toLowerCase();
  return t === "glsltop" || t === "glslmultitop";
}

interface RunLintOptions {
  /** Already-loaded source recipes (use this from the script). */
  sources?: LoadedRecipe[];
  /** Explicit recipes directory; defaults to recipesDir(). */
  dir?: string;
}

/** Pure rule engine — exported for the CLI script and unit tests. */
export function runLint(
  sources: LoadedRecipe[],
  knowledge: Pick<KnowledgeBase, "operatorExists">,
  args: LintRecipeLibraryArgs,
): LintReport {
  const activeRules: RuleId[] = (args.rules ?? [...RULE_IDS]) as RuleId[];
  const enabled = new Set<RuleId>(activeRules);
  const minRank = SEVERITY_RANK[args.severity];
  const reports: RecipeReport[] = [];

  const filtered = args.recipe_id
    ? sources.filter(
        (s) => s.id === args.recipe_id || s.file.replace(/\.json$/, "") === args.recipe_id,
      )
    : sources;

  for (const src of filtered) {
    const findings: Finding[] = [];
    const push = (rule: RuleId, path: string, message: string, hint?: string): void => {
      if (!enabled.has(rule)) return;
      const item: Finding = { rule, path, message };
      if (hint !== undefined) item.hint = hint;
      findings.push(item);
    };

    const parseError = (src as LoadedRecipe & { parseError?: string }).parseError;
    if (parseError) {
      push("schema", "(file)", `Failed to parse JSON: ${parseError}`);
    } else if (src.schemaError) {
      for (const issue of src.schemaError.issues) {
        push("schema", issue.path.length > 0 ? issue.path.join(".") : "(root)", issue.message);
      }
    }

    const r = src.recipe;
    if (r) {
      // id / filename
      const base = src.file.replace(/\.json$/, "");
      if (r.id !== base) {
        push(
          "id_filename_match",
          "id",
          `Recipe id "${r.id}" does not match filename "${src.file}".`,
          "Rename the file or the id so they line up.",
        );
      }

      // Build node-name lookup; report duplicates while doing it.
      const nodesByName = new Map<string, { type: string; index: number }>();
      r.nodes.forEach((node, i) => {
        if (nodesByName.has(node.name)) {
          push(
            "duplicate_node_names",
            `nodes[${i}].name`,
            `Duplicate node name "${node.name}" (first seen at index ${nodesByName.get(node.name)?.index}).`,
          );
        } else {
          nodesByName.set(node.name, { type: node.type, index: i });
        }
      });

      // Operator existence + GLSL host + render/parent rules per node.
      r.nodes.forEach((node, i) => {
        if (!knowledge.operatorExists(node.type)) {
          push(
            "unknown_operator",
            `nodes[${i}].type`,
            `Operator type "${node.type}" not found in knowledge base.`,
            "The KB lags TD by ~14 operators; suppress with rules: if a probe in TD confirms it exists.",
          );
        }
        if (node.parent) {
          const parent = nodesByName.get(node.parent);
          if (!parent) {
            push(
              "bad_parent",
              `nodes[${i}].parent`,
              `Parent "${node.parent}" does not resolve to any node in this recipe.`,
            );
          } else if (!isCompType(parent.type)) {
            push(
              "bad_parent",
              `nodes[${i}].parent`,
              `Parent "${node.parent}" is a ${parent.type}, not a COMP.`,
            );
          }
        }
        if (node.render) {
          const parent = node.parent ? nodesByName.get(node.parent) : undefined;
          if (!parent || !/geometryCOMP/i.test(parent.type)) {
            push(
              "render_outside_geo",
              `nodes[${i}]`,
              `Node "${node.name}" has render=true but parent is not a geometryCOMP.`,
            );
          }
        }
      });

      // Connections
      r.connections.forEach((conn, i) => {
        if (!nodesByName.has(conn.from)) {
          push(
            "dangling_connection",
            `connections[${i}].from`,
            `Connection source "${conn.from}" does not match any node.`,
          );
        }
        if (!nodesByName.has(conn.to)) {
          push(
            "dangling_connection",
            `connections[${i}].to`,
            `Connection target "${conn.to}" does not match any node.`,
          );
        }
      });

      // Exposed parameters
      r.parameters.forEach((p, i) => {
        if (!nodesByName.has(p.node)) {
          push(
            "parameter_node_missing",
            `parameters[${i}].node`,
            `Exposed parameter "${p.name}" references unknown node "${p.node}".`,
          );
        } else if (enabled.has("parameter_par_unknown")) {
          // Best-effort: we don't have full param docs here, leave as info-only stub.
          // (No emit; rule kept for future expansion without changing the schema.)
        }
      });

      // GLSL uniforms must attach to a GLSL TOP host.
      r.glsl_uniforms.forEach((u, i) => {
        const host = nodesByName.get(u.node);
        if (!host) {
          push(
            "glsl_uniform_host",
            `glsl_uniforms[${i}].node`,
            `GLSL uniform "${u.name}" references unknown node "${u.node}".`,
          );
        } else if (!isGlslTopType(host.type)) {
          push(
            "glsl_uniform_host",
            `glsl_uniforms[${i}].node`,
            `GLSL uniform "${u.name}" attached to non-GLSL host "${u.node}" (type ${host.type}).`,
            "Uniforms only bind on glslTOP / glslmultiTOP.",
          );
        }
      });

      // Controls: bind_to resolution.
      r.controls.forEach((c, i) => {
        const binds = c.bind_to ?? [];
        binds.forEach((bind, j) => {
          // bind format: "nodeName.parName"
          const dot = bind.lastIndexOf(".");
          const nodeRef = dot >= 0 ? bind.slice(0, dot) : bind;
          // Strip any leading "/path/" — bind_to in recipes uses the recipe node name,
          // but be permissive with a trailing segment.
          const lastSeg = nodeRef.split("/").filter(Boolean).pop() ?? nodeRef;
          if (!nodesByName.has(lastSeg)) {
            push(
              "control_bind_unresolved",
              `controls[${i}].bind_to[${j}]`,
              `Control "${c.name}" bind_to "${bind}" does not resolve to any recipe node.`,
            );
          }
        });
      });

      // Soft hygiene.
      if (r.tags.length === 0) {
        push("tags_empty", "tags", `Recipe "${r.id}" has no tags.`);
      }
      if (!r.description.trim()) {
        push("description_empty", "description", `Recipe "${r.id}" has empty description.`);
      }
      if (!r.preview_description.trim()) {
        push(
          "preview_description_empty",
          "preview_description",
          `Recipe "${r.id}" has empty preview_description.`,
        );
      }
    }

    const errors: Finding[] = [];
    const warnings: Finding[] = [];
    const info: Finding[] = [];
    for (const f of findings) {
      const sev = RULE_SEVERITY[f.rule];
      if (SEVERITY_RANK[sev] < minRank) continue;
      if (sev === "error") errors.push(f);
      else if (sev === "warn") warnings.push(f);
      else info.push(f);
    }

    reports.push({ id: src.id, file: src.file, errors, warnings, info });
  }

  const withErrors = reports.filter((r) => r.errors.length > 0).length;
  const withWarnings = reports.filter((r) => r.warnings.length > 0).length;

  return {
    summary: {
      totalRecipes: reports.length,
      withErrors,
      withWarnings,
      rulesRun: activeRules,
    },
    recipes: reports,
  };
}

function renderMarkdown(report: LintReport): string {
  const lines: string[] = [];
  lines.push(
    `Linted ${report.summary.totalRecipes} recipe(s): ${report.summary.withErrors} with errors, ${report.summary.withWarnings} with warnings.`,
  );
  let shown = 0;
  outer: for (const rec of report.recipes) {
    const all: Array<{ sev: string; f: Finding }> = [
      ...rec.errors.map((f) => ({ sev: "error", f })),
      ...rec.warnings.map((f) => ({ sev: "warn", f })),
      ...rec.info.map((f) => ({ sev: "info", f })),
    ];
    if (all.length === 0) continue;
    lines.push("", `### ${rec.file} (${rec.id})`);
    for (const item of all) {
      lines.push(`- **${item.sev}** \`${item.f.rule}\` @ ${item.f.path}: ${item.f.message}`);
      shown++;
      if (shown >= 20) break outer;
    }
  }
  return lines.join("\n");
}

export function lintRecipeLibraryImpl(
  ctx: Pick<ToolContext, "recipes" | "knowledge"> & Partial<ToolContext>,
  args: LintRecipeLibraryArgs,
  opts: RunLintOptions = {},
) {
  let sources = opts.sources;
  if (!sources) {
    try {
      sources = loadRecipesForLint({ dir: opts.dir, recipes: ctx.recipes });
    } catch (err) {
      return errorResult(`Failed to load recipes: ${String(err)}`);
    }
  }

  const report = runLint(sources, ctx.knowledge, args);

  const hasError = report.recipes.some((r) => r.errors.length > 0);
  const hasWarn = report.recipes.some((r) => r.warnings.length > 0);
  const shouldFail =
    args.fail_on === "never" ? false : args.fail_on === "warn" ? hasError || hasWarn : hasError;

  const summary = renderMarkdown(report);
  if (shouldFail) {
    return errorResult(summary, report);
  }
  return structuredResult(summary, report as unknown as Record<string, unknown>);
}

export const registerLintRecipeLibrary: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "lint_recipe_library",
    {
      title: "Lint recipe library",
      description:
        "Offline semantic linter for recipes/*.json. Checks schema, id/filename match, duplicate node names, unknown operator types, dangling connections, bad parents, render-outside-geometryCOMP, missing parameter nodes, unresolved control bind_to, GLSL uniforms on non-GLSL hosts, and hygiene (tags/description/preview_description). Returns a structured report; never calls TouchDesigner.",
      inputSchema: lintRecipeLibrarySchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    (args) => lintRecipeLibraryImpl(ctx, args),
  );
};
