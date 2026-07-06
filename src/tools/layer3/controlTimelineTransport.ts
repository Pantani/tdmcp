import { z } from "zod";
import { tryEndpoint } from "../../td-client/types.js";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const controlTimelineTransportSchema = z.object({
  action: z
    .enum(["play", "pause", "seek", "cue", "rate"])
    .describe(
      "Transport verb: play — start playback; pause — stop playback; seek — jump to a frame; cue — jump to a named cue point; rate — set playback rate.",
    ),
  frame: z
    .number()
    .int()
    .optional()
    .describe("Target frame for seek (required when action='seek')."),
  rate: z
    .number()
    .positive()
    .optional()
    .describe(
      "Playback rate multiplier for rate (required when action='rate'). 1.0=normal, 0.5=half, 2.0=double.",
    ),
  cueName: z.string().optional().describe("Named cue point for cue (required when action='cue')."),
});

export type ControlTimelineTransportArgs = z.infer<typeof controlTimelineTransportSchema>;

export interface TimelineState {
  action: string;
  play: boolean;
  frame: number;
  rate: number;
  startFrame: number;
  endFrame: number;
  fps: number;
}

const PAYLOAD_TEMPLATE = `
import base64, json, sys
_payload_b64 = "__PAYLOAD_B64__"
PAYLOAD = json.loads(base64.b64decode(_payload_b64).decode("utf-8"))

_action = PAYLOAD["action"]

if _action == "play":
    project.play = True
elif _action == "pause":
    project.play = False
elif _action == "seek":
    _target = max(project.startFrame, min(int(PAYLOAD["frame"]), project.endFrame))
    me.time.frame = _target
elif _action == "cue":
    _name = PAYLOAD["cueName"]
    try:
        project.cue(_name)
    except Exception:
        raise RuntimeError(f"cue '{_name}' not found")
elif _action == "rate":
    project.rate = float(PAYLOAD["rate"])

import json as _json
result = {
    "action": PAYLOAD["action"],
    "play": bool(project.play),
    "frame": int(me.time.frame),
    "rate": float(project.rate),
    "startFrame": int(project.startFrame),
    "endFrame": int(project.endFrame),
    "fps": float(project.cookRate),
}
print(_json.dumps(result))
`.trim();

export async function controlTimelineTransportImpl(
  ctx: ToolContext,
  args: ControlTimelineTransportArgs,
): Promise<ReturnType<typeof structuredResult>> {
  // Cross-field validation
  if (args.action === "seek" && args.frame === undefined) {
    return errorResult("seek requires `frame`");
  }
  if (args.action === "cue" && !args.cueName) {
    return errorResult("cue requires `cueName`");
  }
  if (args.action === "rate" && args.rate === undefined) {
    return errorResult("rate requires `rate`");
  }

  const payload: Record<string, unknown> = { action: args.action };
  if (args.frame !== undefined) payload.frame = args.frame;
  if (args.rate !== undefined) payload.rate = args.rate;
  if (args.cueName !== undefined) payload.cueName = args.cueName;

  const script = buildPayloadScript(PAYLOAD_TEMPLATE, payload);

  return guardTd(
    async () => {
      // 1) First-class endpoint POST /api/transport — survives ALLOW_EXEC=0 and
      //    is the same response shape (TransportStateSchema) the exec path emits.
      // 2) Fall back to exec ONLY when the endpoint is absent on an older bridge;
      //    validation 400s (e.g. unknown cue) surface unchanged via tryEndpoint.
      return tryEndpoint<TimelineState>(
        async () => {
          const endpointPayload: Parameters<typeof ctx.client.controlTimelineTransport>[0] = {
            action: args.action,
          };
          if (args.frame !== undefined) endpointPayload.frame = args.frame;
          if (args.rate !== undefined) endpointPayload.rate = args.rate;
          if (args.cueName !== undefined) endpointPayload.cueName = args.cueName;
          const state = await ctx.client.controlTimelineTransport(endpointPayload);
          return state as TimelineState;
        },
        async () => {
          const res = await ctx.client.executePythonScript(script, true);
          const stdout = (res as { stdout?: string }).stdout;
          return parsePythonReport<TimelineState>(stdout);
        },
      );
    },
    (state) => {
      const msg = `Timeline ${state.action} (frame ${state.frame}, rate ${state.rate.toFixed(2)}x, ${state.fps} fps)`;
      return structuredResult(msg, state);
    },
  );
}

export const registerControlTimelineTransport: ToolRegistrar = (server, ctx) =>
  server.registerTool(
    "control_timeline_transport",
    {
      title: "Control Timeline Transport",
      description:
        "Drive the TouchDesigner project timeline: play, pause, seek to a frame, jump to a named cue, or set playback rate. Returns the timeline state after the action so a copilot can verify the change took effect. NOTE: pausing will freeze any downstream motion/feedback/frame-diff chain — expected behaviour, not a bug.",
      inputSchema: controlTimelineTransportSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => controlTimelineTransportImpl(ctx, args),
  );
