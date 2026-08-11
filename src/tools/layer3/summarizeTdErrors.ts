import { z } from "zod";
import { guardTd, structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { parentOf } from "./nodeMatch.js";

export const summarizeTdErrorsSchema = z.object({
  path: z.string().default("/project1").describe("Network root to collect diagnostics under."),
  group_by: z
    .enum(["message", "type", "parent"])
    .default("message")
    .describe(
      "How to cluster diagnostics: by exact message, by severity type (error/warning), or by parent container.",
    ),
});
type SummarizeTdErrorsArgs = z.infer<typeof summarizeTdErrorsSchema>;
type DiagnosticSeverity = "error" | "warning";

const normalizeDiagnosticSeverity = (type?: string): DiagnosticSeverity =>
  type === "warning" ? "warning" : "error";

export const summarizeTdErrorsOutputSchema = z.object({
  path: z.string().describe("The network root diagnostics were collected under."),
  total: z
    .number()
    .describe("Total number of diagnostics found across the network (errors + warnings)."),
  error_count: z.number().describe("Number of error-severity diagnostics."),
  warning_count: z.number().describe("Number of warning-severity diagnostics."),
  group_by: z.enum(["message", "type", "parent"]).describe("How the diagnostics were clustered."),
  groups: z
    .array(
      z.object({
        key: z.string().describe("The shared message, type, or parent path for this cluster."),
        count: z.number().describe("How many diagnostics fall into this cluster."),
        sample: z
          .object({
            path: z.string().describe("Path of one representative node in this cluster."),
            message: z.string().describe("That node's diagnostic message, as a concrete example."),
            type: z
              .enum(["error", "warning"])
              .describe("Severity of the representative diagnostic."),
          })
          .describe("One representative diagnostic from the cluster."),
      }),
    )
    .describe("Diagnostic clusters, largest first."),
  suggestions: z
    .array(z.string())
    .describe("Plain-language next steps, including which nodes to inspect first."),
});

export async function summarizeTdErrorsImpl(ctx: ToolContext, args: SummarizeTdErrorsArgs) {
  return guardTd(
    () => ctx.client.getNetworkErrors(args.path),
    (result) => {
      const diagnostics = result.errors.map((diagnostic) => ({
        ...diagnostic,
        severity: normalizeDiagnosticSeverity(diagnostic.type),
      }));
      const total = diagnostics.length;
      const errorCount = diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
      const warningCount = diagnostics.filter(
        (diagnostic) => diagnostic.severity === "warning",
      ).length;
      if (total === 0) {
        return structuredResult(`No errors or warnings found under ${args.path}.`, {
          path: args.path,
          total: 0,
          error_count: 0,
          warning_count: 0,
          group_by: args.group_by,
          groups: [],
          suggestions: [],
        });
      }

      const keyOf = (e: { path: string; message: string; severity: DiagnosticSeverity }): string =>
        args.group_by === "message"
          ? e.message
          : args.group_by === "type"
            ? e.severity
            : parentOf(e.path);

      const grouped = new Map<
        string,
        { count: number; sample: { path: string; message: string; type: "error" | "warning" } }
      >();
      const byPath = new Map<string, number>();
      for (const e of diagnostics) {
        const key = keyOf(e);
        const g = grouped.get(key);
        if (g) g.count += 1;
        else {
          grouped.set(key, {
            count: 1,
            sample: {
              path: e.path,
              message: e.message,
              type: e.severity,
            },
          });
        }
        byPath.set(e.path, (byPath.get(e.path) ?? 0) + 1);
      }

      const groups = [...grouped.entries()]
        .map(([key, g]) => ({ key, count: g.count, sample: g.sample }))
        .sort((a, b) => b.count - a.count);

      const worstNodes = [...byPath.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([p, c]) => `${p} (${c} diagnostic${c === 1 ? "" : "s"})`);

      const suggestions: string[] = [];
      if (groups[0] && groups[0].count > 1) {
        suggestions.push(
          `${groups[0].count} diagnostics share ${args.group_by} "${groups[0].key}"; inspect the representative sample and affected nodes together.`,
        );
      }
      if (worstNodes.length > 0) {
        suggestions.push(`Check first: ${worstNodes.join(", ")}.`);
      }

      return structuredResult(
        `${total} diagnostic(s) under ${args.path}: ${errorCount} error(s), ${warningCount} warning(s), in ${groups.length} ${args.group_by} group(s).`,
        {
          path: args.path,
          total,
          error_count: errorCount,
          warning_count: warningCount,
          group_by: args.group_by,
          groups,
          suggestions,
        },
      );
    },
  );
}

export const registerSummarizeTdErrors: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "summarize_td_errors",
    {
      title: "Summarize network errors",
      description:
        "Read-only: collect errors and warnings across a network and cluster them by message, severity type, or parent container, with the nodes that have the most diagnostics and a suggested order to investigate. Returns {total, error_count, warning_count, groups[], suggestions[]}; each group sample retains its error/warning severity. Use this for network-wide triage instead of reading every node's diagnostics one by one; use get_td_node_errors when you want the raw list for one node or sub-tree.",
      inputSchema: summarizeTdErrorsSchema.shape,
      outputSchema: summarizeTdErrorsOutputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    (args) => summarizeTdErrorsImpl(ctx, args),
  );
};
