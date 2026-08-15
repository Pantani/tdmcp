import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { allowsCallerCode, callerCodeDenied } from "../codeBearing.js";
import { errorResult, guardTd, jsonStructuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const MAX_PARAMS = 64;
const MAX_MENU_ITEMS = 64;

const parameterStyleSchema = z.enum([
  "Float",
  "Int",
  "Toggle",
  "Menu",
  "Str",
  "Pulse",
  "Header",
  "OP",
  "TOP",
  "File",
  "Folder",
  "XYZW",
  "RGBA",
  // Legacy styles stay valid for backwards compatibility.
  "RGB",
  "XYZ",
]);

const scalarValueSchema = z.union([
  z.number().finite(),
  z.string().max(2048),
  z.boolean(),
  z.array(z.number().finite()).min(1).max(4),
]);

const menuNamesSchema = z.array(z.string().min(1).max(128)).min(1).max(MAX_MENU_ITEMS);
const menuLabelsSchema = z.array(z.string().max(256)).min(1).max(MAX_MENU_ITEMS);

export const customParameterDefinitionSchema = z
  .object({
    name: z.string().min(1).max(128),
    type: parameterStyleSchema,
    label: z.string().min(1).max(256).optional(),
    default: scalarValueSchema.optional(),
    min: z.coerce.number().finite().optional(),
    max: z.coerce.number().finite().optional(),
    clamp: z.boolean().default(false),
    menu_names: menuNamesSchema.optional(),
    menu_labels: menuLabelsSchema.optional(),
    size: z.coerce.number().int().min(1).max(4).optional(),
  })
  .strict()
  .superRefine((parameter, ctx) => {
    if (parameter.type === "Menu" && parameter.menu_names === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["menu_names"],
        message: "menu_names is required for Menu parameters.",
      });
    }
    if (
      parameter.menu_labels !== undefined &&
      (parameter.menu_names === undefined ||
        parameter.menu_labels.length !== parameter.menu_names.length)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["menu_labels"],
        message: "menu_labels must have the same length as menu_names.",
      });
    }
    if (parameter.size !== undefined && parameter.type !== "Float" && parameter.type !== "Int") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["size"],
        message: "size is supported only for Float and Int parameters.",
      });
    }
    if (
      parameter.min !== undefined &&
      parameter.max !== undefined &&
      parameter.min > parameter.max
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["min"],
        message: "min must be less than or equal to max.",
      });
    }
  });

const pageNameSchema = z.string().min(1).max(128);
const parameterNameSchema = z.string().min(1).max(128);

const addOperationSchema = z
  .object({
    action: z.literal("add"),
    page: pageNameSchema.default("Custom"),
    params: z.array(customParameterDefinitionSchema).min(1).max(MAX_PARAMS),
  })
  .strict();

const editFieldsSchema = z
  .object({
    label: z.string().min(1).max(256).optional(),
    default: scalarValueSchema.optional(),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
    clamp: z.boolean().optional(),
    value: scalarValueSchema.optional(),
    menu_names: menuNamesSchema.optional(),
    menu_labels: menuLabelsSchema.optional(),
    mode: z.enum(["CONSTANT", "EXPRESSION", "BIND", "EXPORT"]).optional(),
    expression: z.string().min(1).max(2048).optional(),
    bind_expression: z.string().min(1).max(2048).optional(),
  })
  .strict()
  .superRefine((fields, ctx) => {
    if (Object.keys(fields).length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "fields must not be empty." });
    }
    if (fields.mode === "EXPRESSION" && fields.expression === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expression"],
        message: "EXPRESSION mode requires expression.",
      });
    }
    if (fields.mode === "BIND" && fields.bind_expression === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["bind_expression"],
        message: "BIND mode requires bind_expression.",
      });
    }
    if (
      fields.menu_names !== undefined &&
      fields.menu_labels !== undefined &&
      fields.menu_names.length !== fields.menu_labels.length
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["menu_labels"],
        message: "menu_labels must have the same length as menu_names.",
      });
    }
    if (fields.min !== undefined && fields.max !== undefined && fields.min > fields.max) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["min"],
        message: "min must be less than or equal to max.",
      });
    }
  });

const lifecycleOperationSchema = z.discriminatedUnion("action", [
  addOperationSchema,
  z
    .object({
      action: z.literal("edit_parameter"),
      name: parameterNameSchema,
      fields: editFieldsSchema,
    })
    .strict(),
  z.object({ action: z.literal("delete_parameter"), name: parameterNameSchema }).strict(),
  z
    .object({
      action: z.literal("sort_page"),
      page: pageNameSchema,
      order: z.array(parameterNameSchema).min(1).max(MAX_PARAMS),
    })
    .strict(),
  z
    .object({ action: z.literal("rename_page"), page: pageNameSchema, new_name: pageNameSchema })
    .strict(),
  z.object({ action: z.literal("delete_page"), page: pageNameSchema }).strict(),
]);

export const addCustomParametersSchema = z
  .object({
    comp_path: z.string().min(1).max(1024).startsWith("/"),
    page: pageNameSchema.default("Custom"),
    params: z.array(customParameterDefinitionSchema).min(1).max(MAX_PARAMS).optional(),
    operations: z.array(lifecycleOperationSchema).min(1).max(MAX_PARAMS).optional(),
    idempotency_key: z
      .string()
      .min(16)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if ((input.params === undefined) === (input.operations === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide exactly one of legacy params or operations.",
      });
    }
  });

type AddCustomParametersArgs = z.infer<typeof addCustomParametersSchema>;

interface LifecycleReport {
  status:
    | "applied"
    | "unchanged"
    | "replayed"
    | "held"
    | "failed"
    | "rolled_back"
    | "partial_failure";
  comp_path: string;
  results: Array<Record<string, unknown>>;
  rollback: { attempted: boolean; succeeded: boolean };
  warnings: string[];
  request_fingerprint: string;
  undo_label?: string;
  error?: { code: string; message: string };
}

interface LifecycleClient {
  applyCustomParameterLifecycle(
    compPath: string,
    body: {
      page?: string;
      params?: z.infer<typeof customParameterDefinitionSchema>[];
      operations?: z.infer<typeof lifecycleOperationSchema>[];
      idempotency_key?: string;
    },
  ): Promise<LifecycleReport>;
}

function capitalizePage(page: string): string {
  return page.charAt(0).toUpperCase() + page.slice(1);
}

function lifecycleError(report: LifecycleReport): CallToolResult {
  const message = report.error
    ? `Custom parameter lifecycle ${report.status}: ${report.error.code} — ${report.error.message}`
    : `Custom parameter lifecycle ${report.status}.`;
  const result = errorResult(message, report);
  result.structuredContent = report as unknown as Record<string, unknown>;
  return result;
}

function hasCallerCode(args: AddCustomParametersArgs): boolean {
  return (
    args.operations?.some(
      (operation) =>
        operation.action === "edit_parameter" &&
        (operation.fields.mode === "EXPRESSION" ||
          operation.fields.mode === "BIND" ||
          operation.fields.expression !== undefined ||
          operation.fields.bind_expression !== undefined),
    ) ?? false
  );
}

export async function addCustomParametersImpl(ctx: ToolContext, args: AddCustomParametersArgs) {
  if (!allowsCallerCode(ctx) && hasCallerCode(args)) {
    return callerCodeDenied("Custom-parameter expression and bind assignment");
  }
  const client = ctx.client as typeof ctx.client & LifecycleClient;
  const body =
    args.params !== undefined
      ? {
          page: capitalizePage(args.page),
          params: args.params,
          idempotency_key: args.idempotency_key,
        }
      : {
          operations: args.operations,
          idempotency_key: args.idempotency_key,
        };

  return guardTd(
    () => client.applyCustomParameterLifecycle(args.comp_path, body),
    (report) => {
      if (["held", "failed", "rolled_back", "partial_failure"].includes(report.status)) {
        return lifecycleError(report);
      }
      const changed = report.results.filter((result) => result.status === "applied").length;
      return jsonStructuredResult(
        `Custom parameter lifecycle ${report.status} on ${report.comp_path}: ${changed} operation(s) applied.`,
        report,
      );
    },
  );
}

export const registerAddCustomParameters: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "add_custom_parameters",
    {
      title: "Manage custom parameters",
      description:
        "Transactionally add, edit, delete, sort, and organize a COMP's custom parameters through an authenticated structured TouchDesigner route. Legacy page+params calls remain valid. Supports Float, Int, Toggle, Str, Menu, Pulse, Header, OP, TOP, File, Folder, XYZW, RGBA, RGB, and XYZ; EXPRESSION and BIND are reversible and require TDMCP_RAW_PYTHON=on plus TDMCP_BRIDGE_ALLOW_EXEC=1 because their source is caller-supplied code. Constant and page-lifecycle operations remain available in restricted mode. EXPORT is explicitly HELD and returns an error without mutation. Built-ins are protected and failures roll back to the exact prior custom-page snapshot.",
      inputSchema: addCustomParametersSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    (args) => addCustomParametersImpl(ctx, args),
  );
};
