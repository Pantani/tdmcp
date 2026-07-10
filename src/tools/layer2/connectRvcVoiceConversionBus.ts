import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { websocketDatParams } from "./externalShowBridgeHelpers.js";
import {
  type ExternalShowNodeSpec,
  runExternalShowScaffold,
} from "./externalShowBridgeScaffold.js";

export const connectRvcVoiceConversionBusSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the RVC scaffold."),
  name: z.string().default("rvc_voice_conversion_bus").describe("Generated baseCOMP name."),
  source_mode: z
    .enum(["audio_file", "audio_device", "websocket_chunks", "manual"])
    .default("audio_file"),
  audio_file: z.string().default(""),
  model_path: z.string().default("./models/rvc/voice.pth"),
  index_path: z.string().default("./models/rvc/voice.index"),
  server_url: z.string().default("ws://127.0.0.1:9040"),
  request_url: z.string().default("http://127.0.0.1:9040/convert"),
  speaker_count: z.coerce.number().int().min(1).max(32).default(4),
  transpose_semitones: z.coerce.number().min(-24).max(24).default(0),
  active: z.boolean().default(false),
});

type ConnectRvcVoiceConversionBusArgs = z.infer<typeof connectRvcVoiceConversionBusSchema>;

function sourceNode(args: ConnectRvcVoiceConversionBusArgs): ExternalShowNodeSpec {
  if (args.source_mode === "audio_device") {
    return {
      name: "voice_in",
      optype: "audiodeviceinCHOP",
      x: 0,
      y: 120,
      params: { active: args.active ? 1 : 0 },
    };
  }
  if (args.source_mode === "websocket_chunks") {
    return {
      name: "rvc_ws",
      optype: "websocketDAT",
      x: 0,
      y: 120,
      params: websocketDatParams(args.server_url, args.active),
    };
  }
  if (args.source_mode === "manual") {
    return {
      name: "manual_source_notes",
      optype: "textDAT",
      x: 0,
      y: 120,
      text: "Manual mode selected. Use an external adapter to write converted audio paths into output_map.",
    };
  }
  return {
    name: "voice_in",
    optype: "audiofileinCHOP",
    x: 0,
    y: 120,
    params: { file: args.audio_file, play: args.active ? 1 : 0 },
  };
}

function speakerRows(args: ConnectRvcVoiceConversionBusArgs): string[][] {
  const rows = [["speaker", "model_path", "index_path", "transpose_semitones"]];
  for (let index = 1; index <= args.speaker_count; index += 1) {
    rows.push([
      `speaker_${index}`,
      index === 1 ? args.model_path : "./models/rvc/alternate.pth",
      index === 1 ? args.index_path : "./models/rvc/alternate.index",
      String(args.transpose_semitones),
    ]);
  }
  return rows;
}

export async function connectRvcVoiceConversionBusImpl(
  ctx: ToolContext,
  args: ConnectRvcVoiceConversionBusArgs,
) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "rvc_voice_conversion_bus",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        source_mode: args.source_mode,
        audio_file: args.audio_file,
        model_path: args.model_path,
        index_path: args.index_path,
        server_url: args.server_url,
        request_url: args.request_url,
        speaker_count: args.speaker_count,
        transpose_semitones: args.transpose_semitones,
        active: args.active,
      },
      warnings: [
        "This scaffold does not load RVC models, convert audio, or validate latency.",
        "Voice conversion may require performer consent and clear labeling in production workflows.",
      ],
      nodes: [
        sourceNode(args),
        {
          name: "rvc_client",
          optype: "webclientDAT",
          x: 300,
          y: 120,
          params: { url: args.request_url, reqmethod: "POST", active: args.active ? 1 : 0 },
        },
        { name: "speaker_map", optype: "tableDAT", x: 600, y: 120, table: speakerRows(args) },
        {
          name: "output_map",
          optype: "tableDAT",
          x: 600,
          y: -40,
          table: [
            ["output", "role", "path_hint"],
            ["converted_audio", "post-conversion file or stream", "./generated/rvc/latest.wav"],
            ["latency_ms", "adapter telemetry", "measure live"],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 900,
          y: 120,
          text: "Use speaker_map as the explicit model contract. Keep model loading, GPU selection, streaming, and audio routing in a dedicated adapter.",
        },
      ],
    },
    "connect_rvc_voice_conversion_bus failed",
    (report) =>
      `Created RVC voice conversion bus ${report.container_path}; source ${args.source_mode}; speakers ${args.speaker_count}.`,
  );
}

export const registerConnectRvcVoiceConversionBus: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_rvc_voice_conversion_bus",
    {
      title: "Connect RVC voice conversion bus",
      description:
        "Create an RVC-style voice conversion scaffold with source audio, model maps, output contracts, latency notes, and consent warnings.",
      inputSchema: connectRvcVoiceConversionBusSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectRvcVoiceConversionBusImpl(ctx, args),
  );
};
