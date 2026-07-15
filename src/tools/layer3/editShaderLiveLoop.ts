import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { errorResult, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { editDatContentImpl } from "./editDatContent.js";
import { getInlinePreviewImpl } from "./getInlinePreview.js";
import { getTdNodeErrorsImpl } from "./getTdNodeErrors.js";
import { setDatContentImpl } from "./setDatContent.js";

export const editShaderLiveLoopSchema = z.object({
  dat_path: z.string().describe("Absolute path to the GLSL/Text DAT to edit."),
  mode: z
    .enum(["set", "replace"])
    .default("set")
    .describe("set overwrites the shader DAT; replace performs a surgical text replacement."),
  shader_code: z.string().optional().describe("Full shader source. Required when mode is set."),
  old_string: z
    .string()
    .min(1)
    .optional()
    .describe("Substring to find. Required when mode is replace."),
  new_string: z.string().optional().describe("Replacement text. Required when mode is replace."),
  replace_all: z
    .boolean()
    .default(false)
    .describe("For replace mode, replace all matches instead of requiring exactly one match."),
  error_path: z
    .string()
    .optional()
    .describe(
      "Node to inspect for errors after the edit. Defaults to preview_path, then dat_path.",
    ),
  recursive_errors: z
    .boolean()
    .default(false)
    .describe("If true, check errors recursively under error_path."),
  include_preview: z
    .boolean()
    .default(true)
    .describe("Capture a compact inline preview after editing when preview_path is supplied."),
  preview_path: z
    .string()
    .optional()
    .describe(
      "TOP path to preview after the shader edit, usually the GLSL TOP output or Null TOP.",
    ),
  preview_width: z.number().int().min(16).max(1024).default(256).describe("Preview width."),
  preview_height: z.number().int().min(16).max(1024).default(256).describe("Preview height."),
  preview_format: z.enum(["jpeg", "png"]).default("jpeg").describe("Preview encoding."),
  jpeg_quality: z.number().int().min(1).max(100).default(75).describe("JPEG quality."),
  parent_depth: z
    .number()
    .int()
    .min(0)
    .max(4)
    .default(1)
    .describe("Upstream depth for inline-preview error inspection."),
});
export type EditShaderLiveLoopArgs = z.infer<typeof editShaderLiveLoopSchema>;

interface ShaderLiveLoopReport {
  dat_path: string;
  mode: "set" | "replace";
  edited: boolean;
  edit_summary?: string;
  edit_report?: unknown;
  error_path: string;
  errors?: unknown;
  preview_path?: string;
  preview?: unknown;
  warnings: string[];
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .find((line) => line.trim().length > 0)
      ?.trim() ?? text.trim()
  );
}

function jsonFenceOf(result: CallToolResult): unknown {
  const match = /```json\n([\s\S]*?)\n```/.exec(textOf(result));
  if (!match?.[1]) return undefined;
  try {
    return JSON.parse(match[1]);
  } catch {
    return undefined;
  }
}

function structuredOf(result: CallToolResult): Record<string, unknown> | undefined {
  return (result as { structuredContent?: Record<string, unknown> }).structuredContent;
}

function compactPreview(data: Record<string, unknown>): Record<string, unknown> {
  const thumbnail = data.thumbnail;
  if (!thumbnail || typeof thumbnail !== "object") return data;
  const thumb = thumbnail as Record<string, unknown>;
  return {
    ...data,
    thumbnail: {
      format: thumb.format,
      width: thumb.width,
      height: thumb.height,
      bytes: thumb.bytes,
      base64_omitted: true,
    },
  };
}

export async function editShaderLiveLoopImpl(ctx: ToolContext, args: EditShaderLiveLoopArgs) {
  if (args.mode === "set" && args.shader_code === undefined) {
    return errorResult("edit_shader_live_loop mode:'set' requires shader_code.");
  }
  if (args.mode === "replace" && (args.old_string === undefined || args.new_string === undefined)) {
    return errorResult("edit_shader_live_loop mode:'replace' requires old_string and new_string.");
  }

  const editResult =
    args.mode === "set"
      ? await setDatContentImpl(ctx, {
          dat_path: args.dat_path,
          text: args.shader_code ?? "",
          confirm_wipe: false,
        })
      : await editDatContentImpl(ctx, {
          dat_path: args.dat_path,
          old_string: args.old_string ?? "",
          new_string: args.new_string ?? "",
          replace_all: args.replace_all,
        });

  if (editResult.isError) {
    return errorResult(
      `Could not edit shader DAT ${args.dat_path}: ${firstLine(textOf(editResult))}`,
      {
        dat_path: args.dat_path,
        mode: args.mode,
        edit: jsonFenceOf(editResult) ?? textOf(editResult),
      },
    );
  }

  const warnings: string[] = [];
  const errorPath = args.error_path ?? args.preview_path ?? args.dat_path;
  const report: ShaderLiveLoopReport = {
    dat_path: args.dat_path,
    mode: args.mode,
    edited: true,
    edit_summary: firstLine(textOf(editResult)),
    edit_report: jsonFenceOf(editResult),
    error_path: errorPath,
    warnings,
  };

  const errorsResult = await getTdNodeErrorsImpl(ctx, {
    path: errorPath,
    recursive: args.recursive_errors,
    summary: false,
  });
  if (errorsResult.isError) {
    warnings.push(`Could not inspect errors at ${errorPath}: ${firstLine(textOf(errorsResult))}`);
  } else {
    report.errors = structuredOf(errorsResult);
  }

  if (args.include_preview) {
    if (!args.preview_path) {
      warnings.push("Preview skipped because preview_path was not supplied.");
    } else {
      const previewResult = await getInlinePreviewImpl(ctx, {
        path: args.preview_path,
        width: args.preview_width,
        height: args.preview_height,
        format: args.preview_format,
        jpeg_quality: args.jpeg_quality,
        parent_depth: args.parent_depth,
        max_changed_params: 12,
        include_full_params: false,
      });
      report.preview_path = args.preview_path;
      if (previewResult.isError) {
        warnings.push(
          `Could not capture preview at ${args.preview_path}: ${firstLine(textOf(previewResult))}`,
        );
      } else {
        const preview = structuredOf(previewResult);
        report.preview = preview ? compactPreview(preview) : firstLine(textOf(previewResult));
      }
    }
  }

  const errorData = report.errors as { total?: number } | undefined;
  const errorCount = typeof errorData?.total === "number" ? errorData.total : 0;
  const previewSuffix = report.preview ? ` Preview checked at ${args.preview_path}.` : "";
  const warningSuffix = warnings.length ? ` ${warnings.length} warning(s).` : "";
  return jsonResult(
    `Edited shader DAT ${args.dat_path}; post-edit check found ${errorCount} error(s).${previewSuffix}${warningSuffix}`,
    report,
  );
}

export const registerEditShaderLiveLoop: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "edit_shader_live_loop",
    {
      title: "Edit shader live loop",
      description:
        "Edit a GLSL/Text DAT and immediately run the practical shader feedback loop: write or surgically replace source text, inspect the shader/output node for errors, and optionally capture a compact inline preview. Uses set_dat_content/edit_dat_content under the hood so DAT write guardrails stay consistent.",
      inputSchema: editShaderLiveLoopSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    (args) => editShaderLiveLoopImpl(ctx, args),
  );
};
