import { z } from "zod";
import { errorResult, guardTd, jsonStructuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const tdPath = z
  .string()
  .min(1)
  .max(1_024)
  .refine((value) => value.startsWith("/"), "Operator paths must be absolute.");

const boundedParameters = z
  .record(z.string().min(1).max(128), z.unknown())
  .superRefine((value, refineCtx) => {
    if (Object.keys(value).length > 64) {
      refineCtx.addIssue({
        code: "custom",
        message: "parameters supports at most 64 entries",
      });
    }
  });

export const insertOperatorAtSelectionSchema = z
  .object({
    type: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z][A-Za-z0-9]*$/)
      .describe("Live-creatable same-family TouchDesigner operator type, e.g. nullTOP."),
    name: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
      .optional()
      .describe("Optional valid TouchDesigner operator name; TD generates one when omitted."),
    parameters: boundedParameters
      .optional()
      .describe("At most 64 bounded JSON parameter values applied only to the new operator."),
    expected_context: z
      .object({
        owner_path: tdPath,
        selected_path: tdPath,
        current_path: tdPath,
      })
      .strict()
      .describe(
        "Exact active Network Editor owner/current/single-selection snapshot to compare immediately before mutation.",
      ),
    idempotency_key: z
      .string()
      .min(16)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/)
      .describe("Opaque retry key; exact retries replay and conflicting payloads fail closed."),
  })
  .strict();

const edgeSchema = z
  .object({
    from_path: tdPath,
    out_index: z.number().int().nonnegative(),
    to_path: tdPath,
    in_index: z.number().int().nonnegative(),
  })
  .strict();

export const insertOperatorAtSelectionOutputSchema = z
  .object({
    status: z.enum(["applied", "replayed"]),
    idempotency_key: z.string().min(16).max(128),
    context: z
      .object({
        owner_path: tdPath,
        selected_path: tdPath,
        current_path: tdPath,
      })
      .strict(),
    node: z
      .object({
        path: tdPath,
        type: z.string().min(1).max(128),
        name: z.string().min(1).max(128),
        nodeX: z.number().int(),
        nodeY: z.number().int(),
        viewer: z.boolean().optional(),
      })
      .strict(),
    before: z.object({ edges: z.array(edgeSchema).max(128) }).strict(),
    after: z.object({ edges: z.array(edgeSchema).max(128) }).strict(),
    rollback: z
      .object({
        attempted: z.boolean(),
        succeeded: z.boolean(),
      })
      .strict(),
    warnings: z.array(z.string().max(512)).max(64),
    undo_label: z.string().max(256).optional(),
  })
  .strict();

type InsertOperatorAtSelectionArgs = z.input<typeof insertOperatorAtSelectionSchema>;
type InsertOperatorAtSelectionReport = z.infer<typeof insertOperatorAtSelectionOutputSchema>;

interface EditorInsertClient {
  insertOperatorAtSelection(
    request: InsertOperatorAtSelectionArgs,
  ): Promise<InsertOperatorAtSelectionReport>;
}

export async function insertOperatorAtSelectionImpl(
  ctx: ToolContext,
  args: InsertOperatorAtSelectionArgs,
) {
  const client = ctx.client as unknown as EditorInsertClient;
  return guardTd(
    () => client.insertOperatorAtSelection(args),
    (unvalidated) => {
      const parsed = insertOperatorAtSelectionOutputSchema.safeParse(unvalidated);
      if (!parsed.success) {
        const result = errorResult(
          "The TouchDesigner bridge returned an invalid insertion receipt; no success is claimed.",
        );
        result.structuredContent = {
          status: "failed",
          error: { code: "INVALID_BRIDGE_RESPONSE" },
        };
        return result;
      }
      const report = parsed.data;
      const verb = report.status === "replayed" ? "Replayed" : "Inserted";
      return jsonStructuredResult(
        `${verb} ${report.node.type} at ${report.node.path}; one downstream edge was replaced and sibling edges were preserved.`,
        report,
      );
    },
  );
}

export const registerInsertOperatorAtSelection: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "insert_operator_at_selection",
    {
      title: "Insert operator at the active selection",
      description:
        "Atomically insert one same-family operator on one deterministic downstream edge of the exactly selected/current TouchDesigner operator. Requires an exact editor-context compare-and-swap and an idempotency key; returns bounded before/after connector receipts, explicit non-overlapping placement and rollback state. Fan-out siblings and sibling inputs are preserved. Uses the authenticated structured bridge with ALLOW_EXEC=0; it never invokes raw Python, mouse-interactive placeOPs, or implicit pane selection.",
      inputSchema: insertOperatorAtSelectionSchema.shape,
      outputSchema: insertOperatorAtSelectionOutputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => insertOperatorAtSelectionImpl(ctx, args),
  );
};
