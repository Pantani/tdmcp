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
  {
    fps: number;
    extension: ".mov" | ".mp4";
    codec: string;
    use: string;
    video_codec: string;
    video_codec_type?: string;
    movie_pixel_format?: string;
  }
> = {
  hap: {
    fps: 60,
    extension: ".mov",
    codec: "HAP",
    use: "VJ playback where fast GPU decoding matters more than small files",
    video_codec: "hap",
    video_codec_type: "hap",
    movie_pixel_format: "rgb",
  },
  hap_alpha: {
    fps: 60,
    extension: ".mov",
    codec: "HAP Alpha",
    use: "VJ playback with transparency / keyable overlays",
    video_codec: "hap",
    video_codec_type: "hap",
    movie_pixel_format: "rgba",
  },
  prores_422: {
    fps: 30,
    extension: ".mov",
    codec: "Apple ProRes 422",
    use: "editorial handoff and high-quality masters",
    video_codec: "prores",
    video_codec_type: "prores422",
    movie_pixel_format: "yuv422",
  },
  prores_4444: {
    fps: 30,
    extension: ".mov",
    codec: "Apple ProRes 4444",
    use: "high-quality alpha-capable masters",
    video_codec: "prores",
    video_codec_type: "prores4444",
    movie_pixel_format: "rgba",
  },
  notchlc: {
    fps: 60,
    extension: ".mov",
    codec: "NotchLC",
    use: "media-server playback when NotchLC is installed on the TD machine",
    video_codec: "notchlc",
  },
  mp4_review: {
    fps: 30,
    extension: ".mp4",
    codec: "H.264 / MP4 review",
    use: "small review files for sharing with collaborators",
    video_codec: "h264",
    movie_pixel_format: "yuv420",
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
    video_codec: preset.video_codec,
    video_codec_type: preset.video_codec_type,
    movie_pixel_format: preset.movie_pixel_format,
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
    video_codec: preset.video_codec,
    video_codec_type: preset.video_codec_type,
    movie_pixel_format: preset.movie_pixel_format,
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
