import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { recordMovieImpl } from "./recordMovie.js";

export const renderPresetSchema = z.enum([
  "hap",
  "hap_alpha",
  "prores_422",
  "prores_4444",
  "notchlc",
  "mp4_review",
]);
export type RenderPreset = z.infer<typeof renderPresetSchema>;

export const exportRenderPresetSchema = z.object({
  action: z
    .enum(["start", "stop"])
    .default("start")
    .describe("Start or stop the preset recording pass."),
  preset: renderPresetSchema.default("hap").describe("Delivery preset to document and apply."),
  node_path: z.string().describe("Path of the TOP to record."),
  file: z
    .string()
    .optional()
    .describe("Output movie path on the TD machine. Required for action=start."),
  fps: z.coerce.number().positive().optional().describe("Override the preset frame rate."),
  seconds: z.coerce
    .number()
    .positive()
    .optional()
    .describe("Optional fixed loop duration. Omit to record until a stop call."),
});
type ExportRenderPresetArgs = z.infer<typeof exportRenderPresetSchema>;

const PRESET_DETAILS: Record<
  RenderPreset,
  { fps: number; extension: ".mov" | ".mp4"; codec: string; use: string }
> = {
  hap: {
    fps: 60,
    extension: ".mov",
    codec: "HAP",
    use: "VJ playback where fast GPU decoding matters more than small files",
  },
  hap_alpha: {
    fps: 60,
    extension: ".mov",
    codec: "HAP Alpha",
    use: "VJ playback with transparency / keyable overlays",
  },
  prores_422: {
    fps: 30,
    extension: ".mov",
    codec: "Apple ProRes 422",
    use: "editorial handoff and high-quality masters",
  },
  prores_4444: {
    fps: 30,
    extension: ".mov",
    codec: "Apple ProRes 4444",
    use: "high-quality alpha-capable masters",
  },
  notchlc: {
    fps: 60,
    extension: ".mov",
    codec: "NotchLC",
    use: "media-server playback when NotchLC is installed on the TD machine",
  },
  mp4_review: {
    fps: 30,
    extension: ".mp4",
    codec: "H.264 / MP4 review",
    use: "small review files for sharing with collaborators",
  },
};

export function resolveRenderPreset(args: ExportRenderPresetArgs) {
  const preset = PRESET_DETAILS[args.preset];
  const warnings: string[] = [];
  if (args.action === "start" && !args.file) {
    warnings.push("A file path is required to start recording.");
  }
  if (args.file && !args.file.toLowerCase().endsWith(preset.extension)) {
    warnings.push(
      `${args.preset} normally writes ${preset.extension}; TouchDesigner will still use the extension in file.`,
    );
  }
  return {
    preset: args.preset,
    codec: preset.codec,
    recommended_use: preset.use,
    recommended_extension: preset.extension,
    fps: args.fps ?? preset.fps,
    warnings,
  };
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

function withPresetSummary(result: CallToolResult, preset: ReturnType<typeof resolveRenderPreset>) {
  const warningText = preset.warnings.length ? ` Warning: ${preset.warnings.join(" ")}` : "";
  return {
    ...result,
    content: [
      {
        type: "text" as const,
        text:
          `Export preset ${preset.preset} (${preset.codec}, ${preset.fps}fps): ${preset.recommended_use}.${warningText}\n\n` +
          textOf(result),
      },
    ],
  };
}

export async function exportRenderPresetImpl(ctx: ToolContext, args: ExportRenderPresetArgs) {
  const preset = resolveRenderPreset(args);
  const result = await recordMovieImpl(ctx, {
    action: args.action,
    node_path: args.node_path,
    file: args.file,
    fps: preset.fps,
    seconds: args.seconds,
  });
  return withPresetSummary(result, preset);
}

export const registerExportRenderPreset: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "export_render_preset",
    {
      title: "Export render preset",
      description:
        "Start/stop a movie export with named VJ/editorial presets (HAP, HAP Alpha, ProRes 422/4444, NotchLC, MP4 review) while reusing record_movie's Movie File Out TOP recorder. This records a TOP to a file written by TouchDesigner and documents the expected codec/extension/fps for downstream playback tools.",
      inputSchema: exportRenderPresetSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => exportRenderPresetImpl(ctx, args),
  );
};
