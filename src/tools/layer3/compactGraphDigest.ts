import { z } from "zod";
import { buildDigest, GraphDigestSchema } from "../../resources/graphDigest.js";
import { friendlyTdError } from "../../td-client/types.js";
import { errorResult, structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const compactGraphDigestSchema = z.object({
  path: z
    .string()
    .default("/project1")
    .describe("TD container/subtree path to digest. Defaults to /project1."),
  max_tokens: z
    .number()
    .int()
    .min(100)
    .max(2000)
    .default(500)
    .describe("Hard ceiling on approximate output tokens (chars/4 heuristic). Default 500."),
  include_errors: z
    .boolean()
    .default(true)
    .describe("Include top-3 grouped error keys. Off for purely structural turns."),
  include_output_chain: z
    .boolean()
    .default(true)
    .describe("Walk the primary output TOP upstream up to output_chain_depth."),
  output_chain_depth: z
    .number()
    .int()
    .min(0)
    .max(16)
    .default(6)
    .describe("How far upstream to walk from the output TOP. 6 fits typical tails."),
  family_top_types: z
    .number()
    .int()
    .min(0)
    .max(10)
    .default(3)
    .describe("Per family, list up to N most-frequent operator types. 0 = counts only."),
});
type CompactGraphDigestArgs = z.infer<typeof compactGraphDigestSchema>;

export const compactGraphDigestOutputSchema = GraphDigestSchema;

export async function compactGraphDigestImpl(ctx: ToolContext, args: CompactGraphDigestArgs) {
  try {
    const data = await buildDigest(ctx.client, args.path, {
      maxTokens: args.max_tokens,
      includeErrors: args.include_errors,
      includeOutputChain: args.include_output_chain,
      outputChainDepth: args.output_chain_depth,
      familyTopTypes: args.family_top_types,
    });
    return structuredResult(data.header, data);
  } catch (err) {
    return errorResult(friendlyTdError(err));
  }
}

export const registerCompactGraphDigest: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "compact_graph_digest",
    {
      title: "Compact graph digest (token-cheap)",
      description:
        "Read-only: compress a TD subtree into a structured digest under max_tokens (default 500). " +
        "Returns {header, nodeCount, connectionCount, primaryOutput, families{count,topTypes}, " +
        "outputChain, errors{total,topGroups}, warnings, approxTokens}. " +
        "Uses getNetworkTopology + getNetworkErrors — no new bridge work. " +
        "Cheaper than get_td_topology / snapshot_td_graph for planning turns.",
      inputSchema: compactGraphDigestSchema.shape,
      outputSchema: compactGraphDigestOutputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    (args) => compactGraphDigestImpl(ctx, args),
  );
};
