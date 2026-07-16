import { z } from "zod";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const boundedPath = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => value.startsWith("/"), {
    message: "TouchDesigner operator paths must be absolute.",
  });
const metadataColorSchema = z.tuple([
  z.number().min(0).max(1),
  z.number().min(0).max(1),
  z.number().min(0).max(1),
]);

export const editTdNodeMetadataBaseSchema = z.object({
  path: boundedPath.describe("Full path of the operator to edit."),
  name: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
    .optional()
    .describe("New operator name."),
  parent_path: boundedPath.optional().describe("Destination parent COMP for a safe move."),
  node_x: z
    .number()
    .int()
    .min(-1_000_000)
    .max(1_000_000)
    .optional()
    .describe("Exact Network Editor X coordinate."),
  node_y: z
    .number()
    .int()
    .min(-1_000_000)
    .max(1_000_000)
    .optional()
    .describe("Exact Network Editor Y coordinate."),
  color: metadataColorSchema.optional().describe("Operator RGB color, each channel in 0..1."),
  comment: z.string().max(2048).optional().describe("Bounded operator comment, including empty."),
  display: z.boolean().optional(),
  render: z.boolean().optional(),
  viewer: z.boolean().optional(),
  bypass: z.boolean().optional(),
  lock: z.boolean().optional(),
  cloneImmune: z.boolean().optional(),
  allowCooking: z.boolean().optional(),
});

const metadataFields = [
  "name",
  "parent_path",
  "node_x",
  "node_y",
  "color",
  "comment",
  "display",
  "render",
  "viewer",
  "bypass",
  "lock",
  "cloneImmune",
  "allowCooking",
] as const;

export const editTdNodeMetadataSchema = editTdNodeMetadataBaseSchema.refine(
  (args) => metadataFields.some((field) => args[field] !== undefined),
  { message: "Provide at least one metadata field to edit." },
);
type EditTdNodeMetadataArgs = z.infer<typeof editTdNodeMetadataBaseSchema>;

export async function editTdNodeMetadataImpl(ctx: ToolContext, args: EditTdNodeMetadataArgs) {
  if (!metadataFields.some((field) => args[field] !== undefined)) {
    return errorResult("Provide at least one metadata field to edit.");
  }

  return guardTd(
    () => ctx.client.editNodeMetadata(args),
    (result) => {
      if (!result.applied) {
        const rollback = result.rolled_back
          ? " The partial edit was rolled back."
          : " TouchDesigner did not confirm a complete rollback.";
        return errorResult(
          `Could not apply all metadata edits to ${args.path}.${rollback}`,
          result,
        );
      }
      const changed = Object.values(result.fields).filter(
        (field) => field.status === "applied" || field.status === "changed",
      ).length;
      return jsonResult(
        `Edited ${changed} metadata field(s); final operator path is ${result.final_path}.`,
        result,
      );
    },
  );
}

export const registerEditTdNodeMetadata: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "edit_td_node_metadata",
    {
      title: "Edit TouchDesigner node metadata",
      description:
        "Atomically edit an operator's name, parent, exact Network Editor position, color, comment, or writable flags. The bridge prevalidates requested fields, reads values back, and rolls back partial failures; parent moves copy and validate the destination before destroying the source. Returns the final path and per-field results. Does not use raw Python fallback.",
      inputSchema: editTdNodeMetadataBaseSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    (args) => editTdNodeMetadataImpl(ctx, args),
  );
};
