import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { runExternalShowScaffold } from "./externalShowBridgeScaffold.js";

export const createLeapMotionHandBusSchema = z.object({
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP for the Leap Motion scaffold."),
  name: z.string().default("leap_motion_hand_bus").describe("Generated baseCOMP name."),
  hand_count: z.coerce.number().int().min(1).max(4).default(2),
  gesture_count: z.coerce.number().int().min(0).max(32).default(6),
  include_image_top: z.boolean().default(false),
  active: z.boolean().default(false),
});

type CreateLeapMotionHandBusArgs = z.infer<typeof createLeapMotionHandBusSchema>;

function handRows(args: CreateLeapMotionHandBusArgs): string[][] {
  const rows = [["hand", "channel_prefix", "purpose"]];
  for (let hand = 0; hand < args.hand_count; hand += 1) {
    rows.push([String(hand), `hand${hand}_`, "palm/finger tracking"]);
  }
  return rows;
}

function gestureRows(args: CreateLeapMotionHandBusArgs): string[][] {
  const gestures = ["pinch", "grab", "swipe", "circle", "tap", "screen_tap"];
  const rows = [["gesture", "channel_hint", "visual_use"]];
  for (let index = 0; index < args.gesture_count; index += 1) {
    const gesture = gestures[index] ?? `gesture_${index + 1}`;
    rows.push([gesture, `leap_${gesture}`, index < 2 ? "continuous" : "trigger"]);
  }
  return rows;
}

export async function createLeapMotionHandBusImpl(
  ctx: ToolContext,
  args: CreateLeapMotionHandBusArgs,
) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "leap_motion_hand_bus",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        hand_count: args.hand_count,
        gesture_count: args.gesture_count,
        include_image_top: args.include_image_top,
        active: args.active,
      },
      warnings: [
        "Leap Motion operator availability depends on drivers and TD build; this scaffold does not validate hardware live.",
        "Gesture channels should be debounced before triggering show-critical cues.",
      ],
      nodes: [
        {
          name: "leap_chop",
          optype: "leapmotionCHOP",
          x: 0,
          y: 120,
          params: { active: args.active ? 1 : 0 },
        },
        {
          name: "leap_top",
          optype: "leapmotionTOP",
          x: 0,
          y: -40,
          params: { active: args.include_image_top && args.active ? 1 : 0 },
        },
        { name: "hand_map", optype: "tableDAT", x: 300, y: 120, table: handRows(args) },
        { name: "gesture_map", optype: "tableDAT", x: 600, y: 120, table: gestureRows(args) },
        {
          name: "status",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["hand_count", String(args.hand_count)],
            ["gesture_count", String(args.gesture_count)],
            ["include_image_top", String(args.include_image_top)],
            ["active", String(args.active)],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Install Leap Motion drivers, verify hand stability in leap_chop, then smooth hand_map and gesture_map channels before binding visuals.",
        },
      ],
    },
    "create_leap_motion_hand_bus failed",
    (report) =>
      `Created Leap Motion hand bus ${report.container_path}; hands ${args.hand_count}; gestures ${args.gesture_count}.`,
  );
}

export const registerCreateLeapMotionHandBus: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_leap_motion_hand_bus",
    {
      title: "Create Leap Motion hand bus",
      description:
        "Create a Leap Motion hand/gesture scaffold with CHOP/TOP placeholders, hand maps, gesture maps, and setup notes.",
      inputSchema: createLeapMotionHandBusSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createLeapMotionHandBusImpl(ctx, args),
  );
};
