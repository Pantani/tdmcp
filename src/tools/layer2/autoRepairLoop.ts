import { z } from "zod";
import type { TdNodeError } from "../../td-client/validators.js";
import { repairNetworkImpl } from "../layer3/repairNetwork.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const FIXER_NAMES = [
  "repair_network",
  "fix_shader",
  "fix_reactivity",
  "summarize_td_errors",
] as const;
export type Fixer = (typeof FIXER_NAMES)[number];

export const autoRepairLoopSchema = z.object({
  path: z.string().default("/project1").describe("Root of the subtree to scan + repair."),
  max_iterations: z.coerce
    .number()
    .int()
    .min(1)
    .max(8)
    .default(3)
    .describe("Hard cap on outer iterations — each iteration = one scan + one route + one apply."),
  dry_run: z
    .boolean()
    .default(true)
    .describe(
      "When true (default), PLAN routes only (no writes). Propagated to repair_network; the loop runs exactly one iteration in dry-run mode.",
    ),
  allowed_fixers: z
    .array(z.enum(FIXER_NAMES))
    .default([...FIXER_NAMES])
    .describe(
      "Subset of fixers the loop may route to. Drop 'repair_network' to make the loop advisory only (prompts + remaining, no writes).",
    ),
  min_progress: z.coerce
    .number()
    .int()
    .min(1)
    .default(1)
    .describe(
      "Convergence threshold — if an iteration clears fewer than this many errors, the loop stops (stalled).",
    ),
  include_warnings: z
    .boolean()
    .default(false)
    .describe(
      "When true, treat 'warning' severity errors as in-scope. Default ignores warnings (no-op until the bridge surfaces severity).",
    ),
});
export type AutoRepairLoopArgs = z.infer<typeof autoRepairLoopSchema>;

type Category =
  | "shader_compile"
  | "reactivity_dead"
  | "expression_bad"
  | "op_disabled"
  | "wiring_missing"
  | "dat_syntax"
  | "unclassified";

interface Cluster {
  key: string;
  count: number;
  category: Category;
  route: Fixer;
  invoked: boolean;
  sample: { path: string; message: string };
}

interface IterationReport {
  index: number;
  errors_before: number;
  errors_after: number;
  clusters: Cluster[];
  repair_steps: unknown[];
}

interface RecommendedPrompt {
  prompt: "fix_shader" | "fix_reactivity";
  args: Record<string, string>;
  why: string;
}

interface AutoRepairLoopReport {
  path: string;
  status: "clean" | "stalled" | "exhausted" | "planned";
  dry_run: boolean;
  iterations: IterationReport[];
  errors_before: number;
  errors_after: number;
  remaining: Array<{ node: string; error: string; category: Category }>;
  recommended_prompts: RecommendedPrompt[];
  warnings: string[];
}

const SHADER_RE = /glsl|compile|fragment|vertex|shader|ERROR: 0:/i;
const REACTIVITY_RE = /no input|0 samples|cook 0|division by zero/i;
const EXPRESSION_RE = /expression|recursion|loop in evaluation|name .* is not defined/i;
const OP_DISABLED_RE = /bypass|display off|not enabled/i;
const WIRING_RE = /missing input|no input connected|input not found/i;
const DAT_SYNTAX_RE = /SyntaxError|IndentationError|NameError/;

function isShaderNode(path: string): boolean {
  return /glsl[a-z0-9]*(TOP|MAT|_top|_mat)?\d*$/i.test(path) || /\/glsl\d*$/i.test(path);
}

function isDatNode(path: string): boolean {
  return /DAT\d*$/i.test(path) || /dat\d*$/i.test(path);
}

function categorize(sample: { path: string; message: string; type?: string }): Category {
  const msg = sample.message;
  const type = sample.type ?? "";
  if (type.toLowerCase() === "glsl" || (SHADER_RE.test(msg) && isShaderNode(sample.path))) {
    return "shader_compile";
  }
  if (SHADER_RE.test(msg) && type.toLowerCase() === "glsl") return "shader_compile";
  if (REACTIVITY_RE.test(msg) && type.toLowerCase() !== "cook") return "reactivity_dead";
  if (EXPRESSION_RE.test(msg)) return "expression_bad";
  if (OP_DISABLED_RE.test(msg)) return "op_disabled";
  if (WIRING_RE.test(msg)) return "wiring_missing";
  if (DAT_SYNTAX_RE.test(msg) && isDatNode(sample.path)) return "dat_syntax";
  return "unclassified";
}

const CATEGORY_ROUTE: Record<Category, Fixer> = {
  shader_compile: "fix_shader",
  reactivity_dead: "fix_reactivity",
  expression_bad: "repair_network",
  op_disabled: "repair_network",
  wiring_missing: "repair_network",
  dat_syntax: "summarize_td_errors",
  unclassified: "summarize_td_errors",
};

function clusterErrors(errors: TdNodeError[]): Cluster[] {
  const grouped = new Map<string, { count: number; sample: TdNodeError }>();
  for (const e of errors) {
    const g = grouped.get(e.message);
    if (g) g.count += 1;
    else grouped.set(e.message, { count: 1, sample: e });
  }
  return [...grouped.entries()]
    .map(([key, g]) => {
      const category = categorize(g.sample);
      const route = CATEGORY_ROUTE[category];
      return {
        key,
        count: g.count,
        category,
        route,
        invoked: false,
        sample: { path: g.sample.path, message: g.sample.message },
      };
    })
    .sort((a, b) => b.count - a.count);
}

function recommendPromptFor(cluster: Cluster): RecommendedPrompt | null {
  if (cluster.route === "fix_shader") {
    return {
      prompt: "fix_shader",
      args: { path: cluster.sample.path, error: cluster.sample.message },
      why: `Shader compile error on ${cluster.sample.path} (${cluster.count} occurrence(s)).`,
    };
  }
  if (cluster.route === "fix_reactivity") {
    return {
      prompt: "fix_reactivity",
      args: { path: cluster.sample.path, error: cluster.sample.message },
      why: `Reactivity dead on ${cluster.sample.path} (${cluster.count} occurrence(s)).`,
    };
  }
  return null;
}

/** Pull the structured payload out of a repair_network CallToolResult JSON fence. */
function extractRepairReport(res: {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}): { errors_after?: number; steps?: unknown[]; warnings?: string[] } | null {
  if (res.isError) return null;
  const block = res.content.find((c) => c.type === "text");
  const text = block?.text ?? "";
  const m = text.match(/```json\n([\s\S]*?)\n```/);
  if (!m?.[1]) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

export async function autoRepairLoopImpl(ctx: ToolContext, args: AutoRepairLoopArgs) {
  const parsed = autoRepairLoopSchema.safeParse(args);
  if (!parsed.success) return errorResult(`Invalid arguments: ${parsed.error.message}`);
  const {
    path,
    max_iterations,
    dry_run,
    allowed_fixers,
    min_progress,
    include_warnings: _include_warnings,
  } = parsed.data;

  const allowed = new Set<Fixer>(allowed_fixers);

  return guardTd(
    async () => {
      const iterations: IterationReport[] = [];
      const warnings: string[] = [];
      const promptKeys = new Set<string>();
      const recommended_prompts: RecommendedPrompt[] = [];
      let firstBefore = 0;
      let lastAfter = 0;
      let status: AutoRepairLoopReport["status"] = "exhausted";
      let lastClusters: Cluster[] = [];
      let lastErrors: TdNodeError[] = [];

      const effectiveMax = dry_run ? 1 : max_iterations;

      for (let i = 1; i <= effectiveMax; i++) {
        const before = await ctx.client.getNetworkErrors(path);
        const errorsBefore = before.errors;
        if (i === 1) firstBefore = errorsBefore.length;

        if (errorsBefore.length === 0) {
          iterations.push({
            index: i,
            errors_before: 0,
            errors_after: 0,
            clusters: [],
            repair_steps: [],
          });
          lastAfter = 0;
          lastErrors = [];
          lastClusters = [];
          status = "clean";
          break;
        }

        const clusters = clusterErrors(errorsBefore);
        lastClusters = clusters;
        let repair_steps: unknown[] = [];

        // Route: invoke repair_network at most once per iteration when allowed
        // and at least one cluster routes to it.
        const hasRepairRoute = clusters.some(
          (c) => c.route === "repair_network" && allowed.has("repair_network"),
        );
        if (hasRepairRoute) {
          const res = await repairNetworkImpl(ctx, {
            parent_path: path,
            max_steps: 1,
            dry_run,
          });
          const rep = extractRepairReport(res);
          if (rep?.steps) repair_steps = rep.steps;
          if (rep?.warnings) warnings.push(...rep.warnings);
          if (res.isError) {
            warnings.push(
              "repair_network returned an error result; treated as no-op this iteration.",
            );
          }
          for (const c of clusters) {
            if (c.route === "repair_network") c.invoked = true;
          }
        }

        // Surface prompt hand-offs for prompt-class routes.
        for (const c of clusters) {
          if ((c.route === "fix_shader" || c.route === "fix_reactivity") && allowed.has(c.route)) {
            const rec = recommendPromptFor(c);
            if (rec) {
              const k = `${rec.prompt}:${rec.args.path}`;
              if (!promptKeys.has(k)) {
                promptKeys.add(k);
                recommended_prompts.push(rec);
              }
            }
          }
        }

        const after = await ctx.client.getNetworkErrors(path);
        const errorsAfter = after.errors;
        lastErrors = errorsAfter;
        lastAfter = errorsAfter.length;

        iterations.push({
          index: i,
          errors_before: errorsBefore.length,
          errors_after: errorsAfter.length,
          clusters,
          repair_steps,
        });

        if (dry_run) {
          status = "planned";
          break;
        }

        if (errorsAfter.length === 0) {
          status = "clean";
          break;
        }

        const cleared = errorsBefore.length - errorsAfter.length;
        if (cleared < min_progress) {
          status = "stalled";
          break;
        }

        if (i === effectiveMax) {
          status = "exhausted";
        }
      }

      const remainingClusterByMsg = new Map<string, Category>();
      for (const c of lastClusters) remainingClusterByMsg.set(c.key, c.category);
      const remaining = lastErrors.map((e) => ({
        node: e.path,
        error: e.message,
        category: remainingClusterByMsg.get(e.message) ?? categorize(e),
      }));

      const report: AutoRepairLoopReport = {
        path,
        status,
        dry_run,
        iterations,
        errors_before: firstBefore,
        errors_after: lastAfter,
        remaining,
        recommended_prompts,
        warnings,
      };
      return report;
    },
    (report) => {
      const summary =
        report.status === "clean"
          ? `auto_repair_loop: clean — ${report.errors_before} → 0 errors under ${report.path} in ${report.iterations.length} iteration(s).`
          : report.status === "planned"
            ? `auto_repair_loop: planned (dry-run) — ${report.errors_before} error(s) clustered; ${report.recommended_prompts.length} prompt hand-off(s) recommended.`
            : report.status === "stalled"
              ? `auto_repair_loop: stalled after ${report.iterations.length} iteration(s) — ${report.errors_after}/${report.errors_before} error(s) remain (no progress ≥ min_progress).`
              : `auto_repair_loop: exhausted after ${report.iterations.length} iteration(s) — ${report.errors_after}/${report.errors_before} error(s) remain.`;
      return jsonResult(summary, report);
    },
  );
}

export const registerAutoRepairLoop: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "auto_repair_loop",
    {
      title: "Auto-repair loop (bounded)",
      description:
        "Driver: scan a subtree for cook errors, cluster them, route each cluster to the right fix (calls repair_network for structural/expression/flag issues; surfaces fix_shader / fix_reactivity as prompt hand-offs the agent must execute next turn), re-check, and iterate until clean, no-progress (stalled), or max_iterations (exhausted). Dry-run by default — one planning iteration, no writes. The loop CANNOT fix shaders or dead reactivity itself; it points the agent at them via recommended_prompts. Returns {status, iterations[], errors_before, errors_after, remaining[], recommended_prompts[], warnings}.",
      inputSchema: autoRepairLoopSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => autoRepairLoopImpl(ctx, args),
  );
};
