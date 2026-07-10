import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { runExternalShowScaffold } from "./externalShowBridgeScaffold.js";

export const connectArkitFaceCaptureSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the ARKit scaffold."),
  name: z.string().default("arkit_face_capture").describe("Generated baseCOMP name."),
  receive_port: z.coerce.number().int().min(1).max(65535).default(11111),
  face_count: z.coerce.number().int().min(1).max(16).default(1),
  blendshape_count: z.coerce.number().int().min(1).max(64).default(52),
  include_head_transform: z.boolean().default(true),
  active: z.boolean().default(false),
});

type ConnectArkitFaceCaptureArgs = z.infer<typeof connectArkitFaceCaptureSchema>;

const CORE_BLENDSHAPES = [
  "eyeBlinkLeft",
  "eyeBlinkRight",
  "jawOpen",
  "mouthSmileLeft",
  "mouthSmileRight",
  "browInnerUp",
  "cheekPuff",
  "tongueOut",
];

function blendshapeRows(args: ConnectArkitFaceCaptureArgs): string[][] {
  const rows = [["index", "blendshape", "osc_address"]];
  for (let index = 0; index < args.blendshape_count; index += 1) {
    const name = CORE_BLENDSHAPES[index] ?? `blendshape_${index + 1}`;
    rows.push([String(index), name, `/arkit/face/0/${name}`]);
  }
  return rows;
}

function transformRows(args: ConnectArkitFaceCaptureArgs): string[][] {
  const rows = [["face", "channel", "osc_address"]];
  if (!args.include_head_transform) return rows;
  for (let face = 0; face < args.face_count; face += 1) {
    for (const channel of ["tx", "ty", "tz", "rx", "ry", "rz"]) {
      rows.push([String(face), channel, `/arkit/face/${face}/head/${channel}`]);
    }
  }
  return rows;
}

export async function connectArkitFaceCaptureImpl(
  ctx: ToolContext,
  args: ConnectArkitFaceCaptureArgs,
) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "arkit_face_capture",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        receive_port: args.receive_port,
        face_count: args.face_count,
        blendshape_count: args.blendshape_count,
        include_head_transform: args.include_head_transform,
        active: args.active,
      },
      warnings: [
        "ARKit app OSC address conventions vary; verify blendshape_map against the sender app before show use.",
        "Face-capture values are untrusted live inputs; clamp and smooth before driving bright or physical outputs.",
      ],
      nodes: [
        {
          name: "osc_dat",
          optype: "oscinDAT",
          x: 0,
          y: 120,
          params: { port: args.receive_port, active: args.active ? 1 : 0 },
        },
        {
          name: "osc_chop",
          optype: "oscinCHOP",
          x: 0,
          y: -40,
          params: { port: args.receive_port, active: args.active ? 1 : 0 },
        },
        {
          name: "blendshape_map",
          optype: "tableDAT",
          x: 300,
          y: 120,
          table: blendshapeRows(args),
        },
        {
          name: "head_transform_map",
          optype: "tableDAT",
          x: 600,
          y: 120,
          table: transformRows(args),
        },
        {
          name: "status",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["receive_port", String(args.receive_port)],
            ["face_count", String(args.face_count)],
            ["blendshape_count", String(args.blendshape_count)],
            ["include_head_transform", String(args.include_head_transform)],
            ["active", String(args.active)],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Send ARKit Face Capture OSC from the iPhone to this machine and map blendshape_map rows into normalized channels before binding expressions or visuals.",
        },
      ],
    },
    "connect_arkit_face_capture failed",
    (report) =>
      `Created ARKit face-capture scaffold ${report.container_path}; blendshapes ${args.blendshape_count}; faces ${args.face_count}.`,
  );
}

export const registerConnectArkitFaceCapture: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_arkit_face_capture",
    {
      title: "Connect ARKit Face Capture",
      description:
        "Create an ARKit Face Capture OSC scaffold with blendshape and head-transform maps for iPhone-driven facial performance.",
      inputSchema: connectArkitFaceCaptureSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectArkitFaceCaptureImpl(ctx, args),
  );
};
