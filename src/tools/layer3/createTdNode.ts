import { z } from "zod";
import { guardTd, jsonStructuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const createTdNodeSchema = z
  .object({
    parent_path: z
      .string()
      .default("/project1")
      .describe("Parent COMP path to create the node inside."),
    type: z
      .string()
      .describe("Operator type string, e.g. 'noiseTOP', 'feedbackTOP', 'nullTOP', 'constantCHOP'."),
    name: z.string().optional().describe("Optional node name (auto-generated if omitted)."),
    parameters: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Optional initial parameter overrides as key→value pairs."),
    placement: z
      .enum(["auto", "explicit"])
      .optional()
      .describe(
        "Optional placement policy. Omit for legacy bridge behavior; 'auto' picks a deterministic free grid cell; 'explicit' requires node_x and node_y.",
      ),
    node_x: z
      .number()
      .finite()
      .min(-1_000_000)
      .max(1_000_000)
      .optional()
      .describe("Exact Network Editor X coordinate."),
    node_y: z
      .number()
      .finite()
      .min(-1_000_000)
      .max(1_000_000)
      .optional()
      .describe("Exact Network Editor Y coordinate."),
    viewer: z
      .boolean()
      .optional()
      .describe("Optional operator viewer state for a newly created node."),
  })
  .superRefine((value, refineCtx) => {
    if (
      value.placement === "explicit" &&
      (value.node_x === undefined || value.node_y === undefined)
    ) {
      refineCtx.addIssue({
        code: "custom",
        path: ["placement"],
        message: "placement='explicit' requires both node_x and node_y",
      });
    }
    if (
      value.placement !== "explicit" &&
      (value.node_x !== undefined || value.node_y !== undefined)
    ) {
      refineCtx.addIssue({
        code: "custom",
        path: ["placement"],
        message: "node_x/node_y require placement='explicit'",
      });
    }
  });
type CreateTdNodeArgs = z.infer<typeof createTdNodeSchema>;

export async function createTdNodeImpl(ctx: ToolContext, args: CreateTdNodeArgs) {
  const warnings: string[] = [];
  if (!ctx.knowledge.operatorExists(args.type)) {
    const suggestions = ctx.knowledge.searchOperators(args.type, 3).map((s) => s.name);
    warnings.push(
      `Operator type "${args.type}" was not found in the knowledge base.${
        suggestions.length ? ` Did you mean: ${suggestions.join(", ")}?` : ""
      }`,
    );
  }
  return guardTd(
    () =>
      ctx.client.createNode({
        parent_path: args.parent_path,
        type: args.type,
        name: args.name,
        parameters: args.parameters,
        placement: args.placement,
        node_x: args.node_x,
        node_y: args.node_y,
        viewer: args.viewer,
      }),
    (node) => {
      const allWarnings = [...warnings];
      if (node.parameter_warnings?.length) {
        allWarnings.push(
          `These parameter(s) were not applied (unknown name or bad value): ${node.parameter_warnings.join(", ")}.`,
        );
      }
      const verb = node.already_existed ? "Reused existing" : "Created";
      if (node.already_existed) {
        allWarnings.push(
          `A ${node.type || args.type} named "${node.name}" already existed at ${args.parent_path}; reused it (idempotent).`,
        );
      }
      return jsonStructuredResult(`${verb} ${node.type || args.type} at ${node.path}.`, {
        node,
        warnings: allWarnings,
      });
    },
  );
}

export const registerCreateTdNode: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_td_node",
    {
      title: "Create TouchDesigner node",
      description:
        "Create a single bare operator (node) inside a parent COMP with optional deterministic auto placement or exact coordinates and viewer state. Omitted placement preserves legacy bridge behavior; idempotently reused nodes keep their existing coordinates. Validates the operator type against the knowledge base and warns (without blocking) on unknown types. Returns {node, warnings[]} for the created node. For a complete wired+arranged network prefer a Layer-1 create_* tool.",
      inputSchema: createTdNodeSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createTdNodeImpl(ctx, args),
  );
};
