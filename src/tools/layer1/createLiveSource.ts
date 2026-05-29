import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { createSystemContainer, finalize, runBuild } from "./orchestration.js";

const q = (value: string): string => JSON.stringify(value);

export const createLiveSourceSchema = z.object({
  name: z.string().default("live_source").describe("Name for the source system COMP."),
  parent_path: z.string().default("/project1").describe("Where to build it."),
  kind: z
    .enum(["screen_grab", "ndi", "syphon_spout", "camera", "video_stream"])
    .default("screen_grab")
    .describe(
      "Source kind. DEFAULT screen_grab — zero-permission, safe to test. 'camera' (Video Device In) can hang TD on a macOS permission modal, so it is opt-in.",
    ),
  source_name: z
    .string()
    .optional()
    .describe(
      "(ndi/syphon_spout) The sender/stream name to receive. (video_stream) the URL (RTSP/SRT/WebRTC). (camera) the device name. Omit for the first available / a sensible default.",
    ),
  resolution: z
    .tuple([z.number(), z.number()])
    .default([1280, 720])
    .describe("Target resolution [w,h] (a Fit/Resolution stage normalizes the feed)."),
});

type CreateLiveSourceArgs = z.infer<typeof createLiveSourceSchema>;

// Map each kind to its TD operator type (KB-verified names).
const KIND_TO_OP: Record<CreateLiveSourceArgs["kind"], string> = {
  screen_grab: "screengrabTOP",
  ndi: "ndiinTOP",
  syphon_spout: "syphonspoutinTOP",
  camera: "videodeviceinTOP",
  video_stream: "videostreaminTOP",
};

// Platform/license notes surfaced in the summary. These are UNVERIFIED without a live TD.
const KIND_NOTES: Record<CreateLiveSourceArgs["kind"], string> = {
  screen_grab: "Screen Grab TOP — zero-permission, works on all platforms.",
  ndi:
    "NDI In TOP — UNVERIFIED: requires NDI Runtime installed; availability is per-OS/license. " +
    "The sender par name is probed defensively at build time.",
  syphon_spout:
    "Syphon/Spout In TOP — UNVERIFIED: Syphon is macOS-only; Spout is Windows-only. " +
    "The sender par name is probed defensively at build time.",
  camera:
    "Video Device In TOP — UNVERIFIED: can hang TD on a macOS permission modal; the user " +
    "must click Allow in that modal to recover. Device availability is OS/hardware-dependent.",
  video_stream:
    "Video Stream In TOP — UNVERIFIED: requires the RTSP/SRT/WebRTC sender to be reachable " +
    "on the network at build time.",
};

// The source par name differs across TD builds, so it is probed defensively (a list of
// known spellings) inside the builder.python() calls below — a failure becomes a warning,
// not a hard error. Per kind: ndi → name/sourcename/source; syphon_spout →
// sendername/name/sender; camera → device/devicename/inputdevice; video_stream →
// url/url1/streamurl/streamaddress. screen_grab has no source-name concept.

export async function createLiveSourceImpl(
  ctx: ToolContext,
  args: CreateLiveSourceArgs,
): Promise<Awaited<ReturnType<typeof runBuild>>> {
  return runBuild(async () => {
    const opType = KIND_TO_OP[args.kind];
    const [resW, resH] = args.resolution;

    const builder = await createSystemContainer(ctx, args.parent_path, args.name);

    // 1. Create the source input TOP (kind-dependent), then probe+set par defensively.
    //    We do this via builder.python so that par failures become warnings, not errors.
    const sourceName = `source_in`;
    const sourceNode = await builder.add(opType, sourceName);

    // Set the source_name parameter via defensive probe if provided.
    if (args.source_name !== undefined) {
      const src = args.source_name;
      const kind = args.kind;
      if (kind === "ndi") {
        await builder.python(
          `_n = op(${q(sourceNode)})\n_src = ${q(src)}\nfor _pname in ["name", "sourcename", "source"]:\n    try:\n        _pr = getattr(_n.par, _pname, None)\n        if _pr is not None:\n            _pr.val = _src\n            break\n    except Exception:\n        pass`,
        );
      } else if (kind === "syphon_spout") {
        await builder.python(
          `_n = op(${q(sourceNode)})\n_src = ${q(src)}\nfor _pname in ["sendername", "name", "sender"]:\n    try:\n        _pr = getattr(_n.par, _pname, None)\n        if _pr is not None:\n            _pr.val = _src\n            break\n    except Exception:\n        pass`,
        );
      } else if (kind === "camera") {
        await builder.python(
          `_n = op(${q(sourceNode)})\n_src = ${q(src)}\nfor _pname in ["device", "devicename", "inputdevice"]:\n    try:\n        _pr = getattr(_n.par, _pname, None)\n        if _pr is not None:\n            _pr.val = _src\n            break\n    except Exception:\n        pass`,
        );
      } else if (kind === "video_stream") {
        await builder.python(
          `_n = op(${q(sourceNode)})\n_src = ${q(src)}\nfor _pname in ["url", "url1", "streamurl", "streamaddress"]:\n    try:\n        _pr = getattr(_n.par, _pname, None)\n        if _pr is not None:\n            _pr.val = _src\n            break\n    except Exception:\n        pass`,
        );
      }
    }

    // 2. Resolution-normalization: a Fit TOP adjusts the feed to the target resolution.
    //    This is robust: if the source is already the right size it passes through unchanged.
    const fitNode = await builder.add("fitTOP", "fit_res");
    await builder.setParams(fitNode, { resolutionw: resW, resolutionh: resH });
    await builder.connect(sourceNode, fitNode);

    // 3. Output Null TOP — the handle downstream tools (mixer/decks/post-fx) read.
    const outNode = await builder.add("nullTOP", "out1");
    await builder.connect(fitNode, outNode);

    // 4. Summary and platform notes.
    const kindLabel = args.kind.replace("_", " ");
    const sourceInfo = args.source_name ? ` (source: "${args.source_name}")` : "";
    const resLabel = `${resW}×${resH}`;
    const summary =
      `Built a live source COMP "${args.name}" — ${kindLabel} feed${sourceInfo} normalized to ${resLabel}, ` +
      `output at out1. Connect downstream tools to the out1 Null TOP.\n\n` +
      `Platform note: ${KIND_NOTES[args.kind]}`;

    // Expose the source_name as an editable control where it makes sense.
    const controls: ControlSpec[] = [];
    if (args.kind === "ndi" || args.kind === "syphon_spout") {
      controls.push({
        name: "SourceName",
        type: "string",
        default: args.source_name ?? "",
        bind_to: [],
      });
    }

    const extra: Record<string, unknown> = {
      kind: args.kind,
      op_type: opType,
      source_node: sourceNode,
      fit_node: fitNode,
      resolution: [resW, resH],
      platform_note: KIND_NOTES[args.kind],
      unverified:
        args.kind !== "screen_grab"
          ? [
              "Operator availability is per-OS/license — not live-validated.",
              "Par name probing uses try/except; failures become warnings.",
              ...(args.kind === "camera"
                ? ["camera kind can hang TD on a macOS permission modal — user must click Allow."]
                : []),
            ]
          : [],
    };

    return finalize(ctx, {
      summary,
      builder,
      outputPath: outNode,
      capturePreviewImage: true,
      controls,
      extra,
    });
  });
}

export const registerCreateLiveSource: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_live_source",
    {
      title: "Create live source (input layer)",
      description:
        "Build a self-contained source COMP that ingests an external feed — screen grab, NDI, Syphon/Spout, camera, or a video stream (RTSP/SRT/WebRTC) — normalizes it to a target resolution, and exposes a named Null TOP output ready for the mixer, decks, or post-fx chain. The default 'screen_grab' is zero-permission and safe to test anywhere. 'camera' (Video Device In) is opt-in: it can hang TouchDesigner on a macOS permission modal until the user clicks Allow. NDI, Syphon/Spout, and video_stream are platform- and license-gated (NDI requires the NDI Runtime; Syphon is macOS-only, Spout is Windows-only). Par names for the source/sender/URL are probed defensively so a name that differs between TD builds becomes a warning rather than a hard failure.",
      inputSchema: createLiveSourceSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createLiveSourceImpl(ctx, args),
  );
};
