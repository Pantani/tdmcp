import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import {
  type ExternalShowNodeSpec,
  runExternalShowScaffold,
} from "./externalShowBridgeScaffold.js";

export const connectWhisperTranscriptionBusSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the Whisper scaffold."),
  name: z.string().default("whisper_transcription_bus").describe("Generated baseCOMP name."),
  source_mode: z
    .enum(["audio_file", "audio_device", "websocket_chunks", "manual_drop"])
    .default("audio_file"),
  audio_file: z.string().default(""),
  server_url: z.string().default("ws://127.0.0.1:9030"),
  language_hint: z.string().default("auto"),
  segment_count: z.coerce.number().int().min(1).max(256).default(12),
  active: z.boolean().default(false),
});

type ConnectWhisperTranscriptionBusArgs = z.infer<typeof connectWhisperTranscriptionBusSchema>;

function sourceNode(args: ConnectWhisperTranscriptionBusArgs): ExternalShowNodeSpec {
  if (args.source_mode === "audio_device") {
    return {
      name: "audio_in",
      optype: "audiodeviceinCHOP",
      x: 0,
      y: 120,
      params: { active: args.active ? 1 : 0 },
    };
  }
  if (args.source_mode === "websocket_chunks") {
    return {
      name: "whisper_ws",
      optype: "websocketDAT",
      x: 0,
      y: 120,
      params: { url: args.server_url, active: args.active ? 1 : 0 },
    };
  }
  if (args.source_mode === "manual_drop") {
    return {
      name: "manual_drop_notes",
      optype: "textDAT",
      x: 0,
      y: 120,
      text: "Manual mode selected. Drop transcript JSON or SRT data into segment_map.",
    };
  }
  return {
    name: "audio_in",
    optype: "audiofileinCHOP",
    x: 0,
    y: 120,
    params: { file: args.audio_file, play: args.active ? 1 : 0 },
  };
}

function segmentRows(args: ConnectWhisperTranscriptionBusArgs): string[][] {
  const rows = [["segment", "start_seconds", "end_seconds", "text", "confidence"]];
  for (let index = 1; index <= args.segment_count; index += 1) {
    rows.push([`segment_${index}`, "", "", "", ""]);
  }
  return rows;
}

export async function connectWhisperTranscriptionBusImpl(
  ctx: ToolContext,
  args: ConnectWhisperTranscriptionBusArgs,
) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "whisper_transcription_bus",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        source_mode: args.source_mode,
        audio_file: args.audio_file,
        server_url: args.server_url,
        language_hint: args.language_hint,
        segment_count: args.segment_count,
        active: args.active,
      },
      warnings: [
        "This scaffold does not run Whisper, request microphone permission, or validate transcription quality.",
        "Treat live mic capture and transcription logs as potentially sensitive; keep retention explicit.",
      ],
      nodes: [
        sourceNode(args),
        {
          name: "transcription_client",
          optype: "webclientDAT",
          x: 300,
          y: 120,
          params: { url: args.server_url, reqmethod: "POST", active: args.active ? 1 : 0 },
        },
        { name: "segment_map", optype: "tableDAT", x: 600, y: 120, table: segmentRows(args) },
        {
          name: "status",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["source_mode", args.source_mode],
            ["language_hint", args.language_hint],
            ["segment_count", String(args.segment_count)],
            ["active", String(args.active)],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Normalize transcript segments into segment_map before driving subtitles, prompts, or cue logic. Keep approval gates separate for generated show actions.",
        },
      ],
    },
    "connect_whisper_transcription_bus failed",
    (report) =>
      `Created Whisper transcription bus ${report.container_path}; source ${args.source_mode}; segments ${args.segment_count}.`,
  );
}

export const registerConnectWhisperTranscriptionBus: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_whisper_transcription_bus",
    {
      title: "Connect Whisper transcription bus",
      description:
        "Create a Whisper-compatible transcription scaffold with audio/file/chunk ingest, segment maps, status tables, and privacy notes.",
      inputSchema: connectWhisperTranscriptionBusSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectWhisperTranscriptionBusImpl(ctx, args),
  );
};
