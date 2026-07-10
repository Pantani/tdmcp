import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { runExternalShowScaffold } from "./externalShowBridgeScaffold.js";

const ltcFrameRates = ["23.976", "24", "25", "29.97", "30", "50", "59.94", "60"] as const;

export const createLtcTimecodeBridgeSchema = z.object({
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP for the LTC timecode scaffold."),
  name: z.string().default("ltc_timecode_bridge").describe("Generated baseCOMP name."),
  mode: z.enum(["receive", "generate", "receive_and_generate"]).default("receive"),
  frame_rate: z.enum(ltcFrameRates).default("30"),
  input_device: z.coerce.number().int().min(0).max(64).default(0),
  output_device: z.coerce.number().int().min(0).max(64).default(0),
  cue_count: z.coerce.number().int().min(1).max(128).default(8),
  active: z.boolean().default(false),
});

type CreateLtcTimecodeBridgeArgs = z.infer<typeof createLtcTimecodeBridgeSchema>;

function timecodeRows(args: CreateLtcTimecodeBridgeArgs): string[][] {
  return [
    ["field", "value"],
    ["mode", args.mode],
    ["frame_rate", args.frame_rate],
    ["input_device", String(args.input_device)],
    ["output_device", String(args.output_device)],
    ["active", String(args.active)],
  ];
}

function cueRows(args: CreateLtcTimecodeBridgeArgs): string[][] {
  const rows = [["cue", "timecode", "action"]];
  for (let index = 0; index < args.cue_count; index += 1) {
    const totalSeconds = 3600 + index * 10;
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const timecode = [hours, minutes, seconds]
      .map((part) => String(part).padStart(2, "0"))
      .join(":");
    rows.push([`cue_${index + 1}`, `${timecode}:00`, index === 0 ? "sync_start" : "trigger"]);
  }
  return rows;
}

export async function createLtcTimecodeBridgeImpl(
  ctx: ToolContext,
  args: CreateLtcTimecodeBridgeArgs,
) {
  const receiveActive = args.active && args.mode !== "generate";
  const outputActive = args.active && args.mode !== "receive";

  return runExternalShowScaffold(
    ctx,
    {
      kind: "ltc_timecode_bridge",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        mode: args.mode,
        frame_rate: args.frame_rate,
        input_device: args.input_device,
        output_device: args.output_device,
        cue_count: args.cue_count,
        active: args.active,
      },
      warnings: [
        "LTC timing depends on audio-device routing, level, and sample-rate stability; verify lock before show playback.",
        "Keep generate mode disconnected from external systems until operator approval confirms the target timecode domain.",
      ],
      nodes: [
        {
          name: "ltc_in",
          optype: "ltcinCHOP",
          x: 0,
          y: 120,
          params: { active: receiveActive ? 1 : 0, device: args.input_device },
        },
        {
          name: "ltc_out",
          optype: "ltcoutCHOP",
          x: 0,
          y: -40,
          params: {
            active: outputActive ? 1 : 0,
            device: args.output_device,
            framerate: args.frame_rate,
          },
        },
        {
          name: "timecode_map",
          optype: "tableDAT",
          x: 300,
          y: 120,
          table: timecodeRows(args),
        },
        { name: "cue_map", optype: "tableDAT", x: 600, y: 120, table: cueRows(args) },
        {
          name: "status",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["mode", args.mode],
            ["frame_rate", args.frame_rate],
            ["cue_count", String(args.cue_count)],
            ["receive_active", String(receiveActive)],
            ["output_active", String(outputActive)],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Patch ltc_in to cue_map only after audio lock is stable. Use ltc_out in generate modes only when the destination timecode domain is isolated and approved.",
        },
      ],
    },
    "create_ltc_timecode_bridge failed",
    (report) =>
      `Created LTC timecode bridge ${report.container_path}; mode ${args.mode}; cues ${args.cue_count}.`,
  );
}

export const registerCreateLtcTimecodeBridge: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_ltc_timecode_bridge",
    {
      title: "Create LTC timecode bridge",
      description:
        "Create an LTC receive/generate scaffold with LTC In/Out CHOP placeholders, cue maps, and routing notes.",
      inputSchema: createLtcTimecodeBridgeSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createLtcTimecodeBridgeImpl(ctx, args),
  );
};
