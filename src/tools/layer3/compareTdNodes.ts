import { z } from "zod";
import { guardTd, structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const compareTdNodesSchema = z.object({
  path_a: z.string().describe("First node path."),
  path_b: z.string().describe("Second node path."),
  only_diff: z
    .boolean()
    .default(true)
    .describe("Return only the parameters that differ (true) or also list the identical ones."),
});
type CompareTdNodesArgs = z.infer<typeof compareTdNodesSchema>;

export const compareTdNodesOutputSchema = z.object({
  a: z.string().describe("Path of the first node compared."),
  b: z.string().describe("Path of the second node compared."),
  type_a: z.string().describe("Operator type of the first node."),
  type_b: z.string().describe("Operator type of the second node."),
  type_match: z.boolean().describe("True if both nodes are the same operator type."),
  differing_count: z.number().describe("Number of parameters whose values differ."),
  same_count: z.number().describe("Number of parameters that are identical on both nodes."),
  differing: z
    .array(
      z.object({
        param: z.string().describe("Name of the differing parameter."),
        a: z.unknown().describe("Its value on the first node."),
        b: z.unknown().describe("Its value on the second node."),
      }),
    )
    .describe("Every parameter that differs, with each node's value."),
  identical: z
    .array(z.string())
    .optional()
    .describe("Names of identical parameters; present only when only_diff is false."),
});

export async function compareTdNodesImpl(ctx: ToolContext, args: CompareTdNodesArgs) {
  return guardTd(
    async () => {
      const [a, b] = await Promise.all([
        ctx.client.getNode(args.path_a),
        ctx.client.getNode(args.path_b),
      ]);
      return { a, b };
    },
    ({ a, b }) => {
      const keys = new Set([...Object.keys(a.parameters), ...Object.keys(b.parameters)]);
      const differing: Array<{ param: string; a: unknown; b: unknown }> = [];
      const identical: string[] = [];
      for (const key of [...keys].sort()) {
        const va = a.parameters[key];
        const vb = b.parameters[key];
        if (JSON.stringify(va) === JSON.stringify(vb)) identical.push(key);
        else differing.push({ param: key, a: va, b: vb });
      }
      const data: Record<string, unknown> = {
        a: a.path,
        b: b.path,
        type_a: a.type,
        type_b: b.type,
        type_match: a.type === b.type,
        differing_count: differing.length,
        same_count: identical.length,
        differing,
      };
      if (!args.only_diff) data.identical = identical;
      return structuredResult(
        `${differing.length} differing parameter(s) between ${a.path} and ${b.path}${a.type === b.type ? "" : ` (types differ: ${a.type} vs ${b.type})`}.`,
        data,
      );
    },
  );
}

export const registerCompareTdNodes: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "compare_td_nodes",
    {
      title: "Compare two nodes",
      description:
        "Read-only: diff the parameters of two nodes, returning only the values that differ (by default). Returns {type_match, differing_count, differing[], same_count}. Useful for aligning settings across similar operators; compares two live nodes, whereas diff_snapshots compares two whole-network snapshots over time.",
      inputSchema: compareTdNodesSchema.shape,
      outputSchema: compareTdNodesOutputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    (args) => compareTdNodesImpl(ctx, args),
  );
};
