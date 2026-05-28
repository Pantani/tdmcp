import { z } from "zod";
import { friendlyTdError } from "../../td-client/types.js";
import { NetworkBuilder, runBuild } from "../layer1/orchestration.js";
import { structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const createOp = z.object({
  action: z.literal("create"),
  type: z.string().describe("Operator type to create (e.g. 'noiseTOP', 'levelTOP')."),
  name: z
    .string()
    .optional()
    .describe(
      "Optional name for the new node; later operations in this batch can reference it (TD may adjust it to avoid collisions).",
    ),
  parent_path: z
    .string()
    .optional()
    .describe("Parent to create this node inside; defaults to `default_parent`."),
  parameters: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Initial parameters to set on the new node, e.g. { period: 2, amplitude: 0.5 }."),
});

const connectOp = z.object({
  action: z.literal("connect"),
  from: z
    .string()
    .describe(
      "Source node — a name created earlier in this batch, or an absolute path (e.g. '/project1/noise1').",
    ),
  to: z
    .string()
    .describe(
      "Target node — a name created earlier in this batch, or an absolute path (e.g. '/project1/level1').",
    ),
  from_output: z.coerce
    .number()
    .int()
    .default(0)
    .describe("Output connector index on the source node (default 0)."),
  to_input: z.coerce
    .number()
    .int()
    .default(0)
    .describe("Input connector index on the target node (default 0)."),
});

const setParamOp = z.object({
  action: z.literal("setParam"),
  path: z
    .string()
    .describe(
      "Node to update — a name created earlier in this batch, or an absolute path. Names are resolved to their created paths.",
    ),
  parameters: z
    .record(z.string(), z.unknown())
    .describe("Parameters to set on the node, e.g. { period: 2, amplitude: 0.5 }."),
});

const opSchema = z.discriminatedUnion("action", [createOp, connectOp, setParamOp]);

export const batchOperationsSchema = z.object({
  default_parent: z
    .string()
    .default("/project1")
    .describe("Parent path for `create` operations that omit `parent_path`."),
  operations: z
    .array(opSchema)
    .min(1)
    .describe(
      "Ordered list of create / connect / setParam operations. Runs in order, fail-forward: a failing operation becomes a warning and the rest still run (not transactional). Names created earlier can be referenced by later connect/setParam operations.",
    ),
});
type BatchOperationsArgs = z.infer<typeof batchOperationsSchema>;

const batchOperationsOutputSchema = z.object({
  default_parent: z.string(),
  results: z.array(z.record(z.string(), z.unknown())),
  warnings: z.array(z.string()),
});

interface OperationResult {
  action: "create" | "connect" | "setParam";
  type?: string;
  path?: string;
  from?: string;
  to?: string;
}

export async function batchOperationsImpl(ctx: ToolContext, args: BatchOperationsArgs) {
  return runBuild(async () => {
    const builder = new NetworkBuilder(ctx, args.default_parent);
    const results: OperationResult[] = [];

    for (const op of args.operations) {
      if (op.action === "create") {
        // NetworkBuilder.add wraps createNode, which is not internally guarded and
        // can throw — keep going so one bad node doesn't sink the rest of the batch.
        try {
          const path = await builder.add(op.type, op.name, op.parameters, op.parent_path);
          results.push({ action: "create", type: op.type, path });
        } catch (err) {
          builder.warnings.push(`Create ${op.type} failed: ${friendlyTdError(err)}`);
        }
      } else if (op.action === "connect") {
        // `from`/`to` may be names created in this batch or absolute paths.
        const fromPath = builder.pathOf(op.from) ?? op.from;
        const toPath = builder.pathOf(op.to) ?? op.to;
        // Already fail-forward — connection failures land in builder.warnings.
        await builder.connect(fromPath, toPath, op.from_output, op.to_input);
        results.push({ action: "connect", from: op.from, to: op.to });
      } else {
        const path = builder.pathOf(op.path) ?? op.path;
        // Already fail-forward — param failures land in builder.warnings.
        await builder.setParams(path, op.parameters);
        results.push({ action: "setParam", path });
      }
    }

    const created = results.filter((r) => r.action === "create").length;
    const connected = results.filter((r) => r.action === "connect").length;
    const set = results.filter((r) => r.action === "setParam").length;
    const summary =
      `Ran ${args.operations.length} operation(s): ${created} created, ${connected} connected, ` +
      `${set} set, ${builder.warnings.length} warning(s).`;
    return structuredResult(summary, {
      default_parent: args.default_parent,
      results,
      warnings: builder.warnings,
    });
  });
}

export const registerBatchOperations: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "batch_operations",
    {
      title: "Batch operations",
      description:
        "Run an ordered list of create / connect / setParam operations in one call (fail-forward, per-operation warnings; not transactional). Exposes the network builder as a general primitive — distinct from set_parameters_batch, which only sets parameters. Names created earlier can be referenced by later connect/setParam operations.",
      inputSchema: batchOperationsSchema.shape,
      outputSchema: batchOperationsOutputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => batchOperationsImpl(ctx, args),
  );
};
