import { z } from "zod";
import { guardTd, structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { parentOf } from "./nodeMatch.js";

export const summarizeTdErrorsSchema = z.object({
  path: z.string().default("/project1").describe("Network root to collect errors under."),
  group_by: z
    .enum(["message", "type", "parent"])
    .default("message")
    .describe(
      "How to cluster errors: by exact message, by error type, or by parent container (to find a common upstream cause).",
    ),
});
type SummarizeTdErrorsArgs = z.infer<typeof summarizeTdErrorsSchema>;

export const summarizeTdErrorsOutputSchema = z.object({
  path: z.string().describe("The network root errors were collected under, echoing the request."),
  total: z.number().describe("Total number of errors found across the network (0 means clean)."),
  group_by: z
    .enum(["message", "type", "parent"])
    .describe("How the errors were clustered, echoing the request."),
  groups: z
    .array(
      z.object({
        key: z.string().describe("The shared message, type, or parent path for this cluster."),
        count: z.number().describe("How many errors fall into this cluster."),
        sample: z
          .object({
            path: z.string().describe("Path of one representative node in this cluster."),
            message: z.string().describe("That node's error message, as a concrete example."),
          })
          .describe("One representative error from the cluster."),
      }),
    )
    .describe("Error clusters, largest first; fixing a big cluster's cause clears it at once."),
  suggestions: z
    .array(z.string())
    .describe("Plain-language next steps, e.g. the common cause and which nodes to check first."),
});

export async function summarizeTdErrorsImpl(ctx: ToolContext, args: SummarizeTdErrorsArgs) {
  return guardTd(
    () => ctx.client.getNetworkErrors(args.path),
    (result) => {
      const errors = result.errors;
      const total = errors.length;
      if (total === 0) {
        return structuredResult(`No errors found under ${args.path}.`, {
          path: args.path,
          total: 0,
          group_by: args.group_by,
          groups: [],
          suggestions: [],
        });
      }

      const keyOf = (e: { path: string; message: string; type?: string }): string =>
        args.group_by === "message"
          ? e.message
          : args.group_by === "type"
            ? e.type || "error"
            : parentOf(e.path);

      const grouped = new Map<
        string,
        { count: number; sample: { path: string; message: string } }
      >();
      const byPath = new Map<string, number>();
      for (const e of errors) {
        const key = keyOf(e);
        const g = grouped.get(key);
        if (g) g.count += 1;
        else grouped.set(key, { count: 1, sample: { path: e.path, message: e.message } });
        byPath.set(e.path, (byPath.get(e.path) ?? 0) + 1);
      }

      const groups = [...grouped.entries()]
        .map(([key, g]) => ({ key, count: g.count, sample: g.sample }))
        .sort((a, b) => b.count - a.count);

      const worstNodes = [...byPath.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([p, c]) => `${p} (${c} error${c === 1 ? "" : "s"})`);

      const suggestions: string[] = [];
      if (groups[0] && groups[0].count > 1) {
        suggestions.push(
          `${groups[0].count} errors share ${args.group_by} "${groups[0].key}" — fixing the common cause clears them at once.`,
        );
      }
      if (worstNodes.length > 0) {
        suggestions.push(`Check first: ${worstNodes.join(", ")}.`);
      }

      return structuredResult(
        `${total} error(s) under ${args.path} in ${groups.length} ${args.group_by} group(s).`,
        { path: args.path, total, group_by: args.group_by, groups, suggestions },
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
        "Read-only: collect errors across a network and cluster them by message, type, or parent container, with the worst-offending nodes and a suggested order to investigate. Returns {total, groups[], suggestions[]}. Use this for network-wide triage instead of reading every node's errors one by one; use get_td_node_errors when you just want the raw error list for one node or sub-tree.",
      inputSchema: summarizeTdErrorsSchema.shape,
      outputSchema: summarizeTdErrorsOutputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    (args) => summarizeTdErrorsImpl(ctx, args),
  );
};
