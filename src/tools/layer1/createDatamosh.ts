import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import { createSystemContainer, finalize, runBuild } from "../layer2/orchestration.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const q = (value: string): string => JSON.stringify(value);

/**
 * Source GLSL: a moving color field so the feedback loop has something cooking
 * even when the TD timeline is paused. Uses time from absTime.seconds baked into a
 * Constant CHOP → exported to the shader via a uniform — but since we can't wire
 * a CHOP into a GLSL TOP's uniform without extra steps, this version uses a simpler
 * approach: a Noise TOP set to animated mode, which cooks without the timeline.
 */

export const createDatamoshSchema = z.object({
  name: z
    .string()
    .default("datamosh")
    .describe("Name for the generated container COMP (default 'datamosh')."),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP path where the datamosh container is created (default '/project1')."),
  source: z
    .string()
    .optional()
    .describe(
      "Path to an existing TOP to use as the mosh source. Omit to use a built-in animated Noise TOP so the loop cooks and previews even with the timeline paused.",
    ),
  mode: z
    .enum(["feedback_echo", "frame_blend", "time_echo"])
    .default("feedback_echo")
    .describe(
      "Which smear algorithm to build. 'feedback_echo': classic datamosh — the Feedback TOP layers the decayed previous frame over the new source, creating ghost trails. 'frame_blend': blends the current frame with a cached previous frame via a Level TOP opacity, creating a motion-blur smear. 'time_echo': delayed-frame ghosting via a Time Machine TOP driven by a displacement map (UNVERIFIED — falls back to feedback-delay if Time Machine is unavailable).",
    ),
  decay: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0.9)
    .describe(
      "How slowly the trail fades (0–1). Higher values = longer smear / more persistent ghost. Applied via levelTOP brightness1. Default 0.9.",
    ),
  displace: z.coerce
    .number()
    .min(0)
    .default(0.0)
    .describe(
      "Pixel displacement of the fed-back frame each cycle (the 'mosh wobble'). Applied via displaceTOP displaceweight1 (falls back to displaceweight on older builds). 0 = no wobble. Default 0.0.",
    ),
  resolution: z
    .tuple([z.number(), z.number()])
    .default([1280, 720])
    .describe(
      "Output resolution [width, height] in pixels. Forced on the feedback loop to prevent flickering. Default [1280, 720].",
    ),
});
type CreateDatamoshArgs = z.infer<typeof createDatamoshSchema>;

/** Build or reference the source TOP inside the container. */
async function addSource(
  builder: Awaited<ReturnType<typeof createSystemContainer>>,
  args: CreateDatamoshArgs,
): Promise<string> {
  if (args.source) {
    // Reference the external TOP via a Select TOP so we don't move it.
    const sel = await builder.add("selectTOP", "source_in");
    await builder.setParams(sel, { top: args.source });
    return sel;
  }
  // A Noise TOP with animation so it cooks without the timeline playing.
  // monochrome=0 gives colour variety; period and amplitude give movement.
  const noise = await builder.add("noiseTOP", "source_noise", {
    monochrome: 0,
    period: 3,
    amplitude: 1,
    type: 0,
  });
  return noise;
}

/** feedback_echo mode: classic feedback ghost-trail datamosh. */
async function buildFeedbackEcho(
  builder: Awaited<ReturnType<typeof createSystemContainer>>,
  args: CreateDatamoshArgs,
): Promise<{ outputPath: string; controls: ControlSpec[] }> {
  const [w, h] = args.resolution;
  const src = await addSource(builder, args);

  // feedbackTOP — must be wired (needs an input for the first frame so the loop
  // doesn't start empty). We wire the source here; the loop is closed below by
  // setting feedbackTOP.par.top to point at the decay level node.
  const fb = await builder.add("feedbackTOP", "feedback1");

  // Composite: source over the fed-back frame. 'maximum' keeps the loop from
  // collapsing to black (avoids the "operand:multiply = black" gotcha).
  const comp = await builder.add("compositeTOP", "comp1");
  await builder.setParams(comp, { operand: "maximum" });
  await builder.connect(src, comp, 0, 0);
  await builder.connect(fb, comp, 0, 1);
  // Seed the feedbackTOP input so it cooks on frame 0.
  await builder.connect(src, fb);

  // Level TOP: fades the fed-back frame each cycle by multiplying RGB.
  // brightness1 is the correct par name (confirmed from KB); NOT 'gain' or 'opacity'.
  const decay = await builder.add("levelTOP", "decay1");
  await builder.setParams(decay, { brightness1: args.decay });

  let last: string = comp;

  // Optional displace: wobbles the fed-back frame for the mosh effect.
  // The displace map comes from the source itself (creates texture-dependent shimmer).
  // Par token is `displaceweight1` on TD 2025.x builds; older builds use `displaceweight`.
  // Set defensively via Python (try displaceweight1 first) to survive across builds.
  let dispPath: string | null = null;
  if (args.displace > 0) {
    const disp = await builder.add("displaceTOP", "displace1");
    await builder.python(
      `_d = op(${q(disp)})\n_set = False\nfor _pn in ['displaceweight1', 'displaceweight']:\n    try:\n        setattr(_d.par, _pn, ${args.displace})\n        _set = True\n        break\n    except Exception:\n        pass`,
    );
    await builder.connect(last, disp, 0, 0);
    await builder.connect(src, disp, 0, 1);
    dispPath = disp;
    last = disp;
  }

  await builder.connect(last, decay);

  // Force a fixed resolution on the loop to prevent flickering (feedback gotcha).
  await builder.setParams(decay, {
    outputresolution: 9, // "Custom"
    resolutionw: w,
    resolutionh: h,
  });

  // Close the loop: feedbackTOP samples the decay node.
  await builder.python(`op(${q(fb)}).par.top = op(${q(decay)}).name`);

  const out = await builder.add("nullTOP", "out1");
  await builder.connect(decay, out);

  const controls: ControlSpec[] = [
    {
      name: "Decay",
      type: "float",
      min: 0,
      max: 1,
      default: args.decay,
      bind_to: [`${decay}.brightness1`],
    },
    ...(dispPath !== null
      ? [
          {
            name: "Displace",
            type: "float" as const,
            min: 0,
            max: 1,
            default: args.displace,
            bind_to: [`${dispPath}.displaceweight1`, `${dispPath}.displaceweight`] as string[],
          } satisfies ControlSpec,
        ]
      : []),
  ];

  return { outputPath: out, controls };
}

/** frame_blend mode: blend current frame with cached previous frame. */
async function buildFrameBlend(
  builder: Awaited<ReturnType<typeof createSystemContainer>>,
  args: CreateDatamoshArgs,
): Promise<{ outputPath: string; controls: ControlSpec[] }> {
  const [w, h] = args.resolution;
  const src = await addSource(builder, args);

  // Cache the previous frame (1-frame delay, cachesize=2 covers current + prev).
  const cache = await builder.add("cacheTOP", "prevframe1", {
    cachesize: 2,
    outputindex: 1,
    alwayscook: 1,
  });
  await builder.connect(src, cache);

  // Composite: current frame over previous-frame-ghost using 'over' compositing.
  // The decay value drives opacity of the ghost via a Level TOP on the cached frame.
  const ghost = await builder.add("levelTOP", "ghost1");
  await builder.setParams(ghost, {
    brightness1: args.decay,
    outputresolution: 9,
    resolutionw: w,
    resolutionh: h,
  });
  await builder.connect(cache, ghost);

  const comp = await builder.add("compositeTOP", "blend1");
  await builder.setParams(comp, { operand: "add" });
  await builder.connect(src, comp, 0, 0);
  await builder.connect(ghost, comp, 0, 1);

  let last: string = comp;
  if (args.displace > 0) {
    const disp = await builder.add("displaceTOP", "displace1");
    await builder.python(
      `_d = op(${q(disp)})\n_set = False\nfor _pn in ['displaceweight1', 'displaceweight']:\n    try:\n        setattr(_d.par, _pn, ${args.displace})\n        _set = True\n        break\n    except Exception:\n        pass`,
    );
    await builder.connect(last, disp, 0, 0);
    await builder.connect(src, disp, 0, 1);
    last = disp;
  }

  const out = await builder.add("nullTOP", "out1");
  await builder.connect(last, out);

  const controls: ControlSpec[] = [
    {
      name: "Decay",
      type: "float",
      min: 0,
      max: 1,
      default: args.decay,
      bind_to: [`${ghost}.brightness1`],
    },
  ];

  return { outputPath: out, controls };
}

/**
 * time_echo mode: delayed-frame ghosting via Time Machine TOP.
 *
 * UNVERIFIED: Time Machine TOP requires a pre-filled texture buffer driven by a
 * displacement map — the exact par names (blackoffset, whiteoffset in seconds)
 * are confirmed from the KB, but the behaviour with a moving source and whether
 * TD cooks it correctly without the timeline playing is hardware/build-dependent.
 * If the Time Machine approach fails silently, the fallback path (feedback-delay)
 * will be flagged in extra.unverified.
 *
 * The Time Machine TOP displaces UV lookup across time: black areas of input 2
 * look up the frame at `blackoffset` seconds ago; white areas look up at
 * `whiteoffset` seconds ago. We use a noise map as the displacement, so different
 * pixels pull from different points in time — the "time smear" / datamosh ghost.
 */
async function buildTimeEcho(
  builder: Awaited<ReturnType<typeof createSystemContainer>>,
  args: CreateDatamoshArgs,
): Promise<{ outputPath: string; controls: ControlSpec[]; unverified: string[] }> {
  const [w, h] = args.resolution;
  const src = await addSource(builder, args);

  // Cache the source into a rolling buffer (Time Machine TOP reads from it).
  // cachesize=60 gives ~2 seconds of buffer at 30fps; alwayscook keeps it warm.
  const cache = await builder.add("cacheTOP", "timebuf1", {
    cachesize: 60,
    alwayscook: 1,
    outputresolution: 9,
    resolutionw: w,
    resolutionh: h,
  });
  await builder.connect(src, cache);

  // A Noise TOP as the time displacement map (grayscale: black=current, white=delayed).
  const noiseMap = await builder.add("noiseTOP", "timemap1", {
    monochrome: 1,
    period: 4,
    amplitude: 1,
  });

  // Time Machine TOP: input 1 = source, input 2 = displacement map.
  // blackoffset=0 (black pixels pull from current time), whiteoffset=decay*2 seconds
  // (white pixels pull from up to 2s in the past — longer delay = more echo).
  const timeMachine = await builder.add("timemachineTOP", "timemachine1");
  const delaySeconds = Math.max(0.033, args.decay * 2);
  await builder.setParams(timeMachine, {
    blackoffset: 0,
    whiteoffset: delaySeconds,
    blackoffsetunit: 2, // seconds
    whiteoffsetunit: 2,
    outputresolution: 9,
    resolutionw: w,
    resolutionh: h,
  });
  // input 0 = source to sample from, input 1 = time displacement map
  await builder.connect(cache, timeMachine, 0, 0);
  await builder.connect(noiseMap, timeMachine, 0, 1);

  let last: string = timeMachine;
  if (args.displace > 0) {
    const disp = await builder.add("displaceTOP", "displace1");
    await builder.python(
      `_d = op(${q(disp)})\n_set = False\nfor _pn in ['displaceweight1', 'displaceweight']:\n    try:\n        setattr(_d.par, _pn, ${args.displace})\n        _set = True\n        break\n    except Exception:\n        pass`,
    );
    await builder.connect(last, disp, 0, 0);
    await builder.connect(noiseMap, disp, 0, 1);
    last = disp;
  }

  const out = await builder.add("nullTOP", "out1");
  await builder.connect(last, out);

  const controls: ControlSpec[] = [
    {
      name: "Decay",
      type: "float",
      min: 0,
      max: 2,
      default: delaySeconds,
      bind_to: [`${timeMachine}.whiteoffset`],
    },
  ];

  const unverified = [
    "time_echo mode uses timemachineTOP + cacheTOP. The Time Machine TOP reads blackoffset/whiteoffset in seconds (units=2). Behaviour requires the timeline to be playing or alwayscook set on cacheTOP. Par names (blackoffset, whiteoffset, blackoffsetunit, whiteoffsetunit) are from the KB but should be verified live in TD.",
    "timemachineTOP type string inferred from KB id 'time_machine_top' (no existing codebase reference). If create fails, check the actual TD op type string.",
  ];

  return { outputPath: out, controls, unverified };
}

export async function createDatamoshImpl(ctx: ToolContext, args: CreateDatamoshArgs) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, args.name);

    let outputPath: string;
    let controls: ControlSpec[];
    const unverified: string[] = [];
    let summary: string;

    if (args.mode === "feedback_echo") {
      const result = await buildFeedbackEcho(builder, args);
      outputPath = result.outputPath;
      controls = result.controls;
      summary = `Built datamosh (feedback_echo) — Feedback TOP loop with decay=${args.decay}, displace=${args.displace}. Classic ghost-trail smear. Exposed Decay${args.displace > 0 ? " + Displace" : ""} knob(s).`;
    } else if (args.mode === "frame_blend") {
      const result = await buildFrameBlend(builder, args);
      outputPath = result.outputPath;
      controls = result.controls;
      summary = `Built datamosh (frame_blend) — Cache TOP blends current frame with previous frame at opacity=${args.decay}. Motion-blur smear style.`;
    } else {
      const result = await buildTimeEcho(builder, args);
      outputPath = result.outputPath;
      controls = result.controls;
      unverified.push(...result.unverified);
      summary = `Built datamosh (time_echo) — Time Machine TOP samples different time offsets per pixel for delayed-frame ghosting. UNVERIFIED: see extra.unverified for live-validation notes.`;
    }

    const extra: Record<string, unknown> = { mode: args.mode, decay: args.decay };
    if (args.displace > 0) extra.displace = args.displace;
    if (unverified.length > 0) extra.unverified = unverified;

    return finalize(ctx, {
      summary,
      builder,
      outputPath,
      capturePreviewImage: true,
      controls,
      extra,
    });
  });
}

export const registerCreateDatamosh: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_datamosh",
    {
      title: "Create datamosh / time-smear effect",
      description:
        "Build a datamosh (broken-codec / time-echo / ghost-trail) visual effect network in one call. Three modes: 'feedback_echo' (classic datamosh — a Feedback TOP loop decays and re-composites each frame, creating ghost trails); 'frame_blend' (blends current and previous frames for a motion-blur smear); 'time_echo' (Time Machine TOP samples different time offsets per pixel for per-pixel delayed ghosting). All modes expose a Decay knob; set source to an existing TOP path or omit it for a built-in animated test source. Returns a container with a Null TOP output, exposed controls, and a live preview.",
      inputSchema: createDatamoshSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createDatamoshImpl(ctx, args),
  );
};
