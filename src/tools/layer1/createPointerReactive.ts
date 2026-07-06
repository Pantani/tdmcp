import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import {
  createSystemContainer,
  finalize,
  type NetworkBuilder,
  runBuild,
} from "../layer2/orchestration.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const q = (value: string): string => JSON.stringify(value);

export const createPointerReactiveSchema = z.object({
  multitouch: z
    .boolean()
    .default(false)
    .describe(
      "When true, note that true multitouch needs a Panel COMP touch source; this build " +
        "always uses Mouse In (single pointer) and reports the limitation as a warning. " +
        "Kept for forward-compat — it does not change what gets built.",
    ),
  demo: z
    .boolean()
    .default(true)
    .describe(
      "Also build a visible feedback-field demo the pointer pushes, so you see it working " +
        "immediately (a bright dot that trails behind the mouse over a decaying feedback field).",
    ),
  sensitivity: z.coerce
    .number()
    .min(0)
    .max(8)
    .default(1)
    .describe("Gain applied to every pointer channel (u, v, velocity, button) before the output."),
  resolution: z
    .tuple([z.number(), z.number()])
    .default([1280, 720])
    .describe("Output resolution [width, height] in pixels for the demo feedback field."),
  parent_path: z
    .string()
    .default("/project1")
    .describe(
      "Parent network where the pointer-reactive container is created (default '/project1').",
    ),
});
type CreatePointerReactiveArgs = z.infer<typeof createPointerReactiveSchema>;

/**
 * Builds the pointer-analysis chain: Mouse In → normalized u/v (0..1) + velocity (vu/vv) +
 * button, merged onto a 'pointer' Null CHOP bind point. Channel names are set directly on the
 * Mouse In CHOP's Position X/Y/Left Button parameters (posxname/posyname/lbuttonname), so no
 * channel renaming is needed and nothing has to guess at Mouse In's default channel names.
 */
async function buildPointerChain(
  builder: NetworkBuilder,
  args: CreatePointerReactiveArgs,
): Promise<{ pointer: string; gain: string }> {
  // Mouse In CHOP: name the raw position/button channels explicitly via its own
  // posxname/posyname/lbuttonname parameters (confirmed operator parameters — no
  // renaming step required). 'output' selects normalized coordinates; the exact menu
  // token can vary by TD build, so it is set defensively in a follow-up Python step
  // whose failure only becomes a warning (builder.python already fails forward).
  const mousein = await builder.add("mouseinCHOP", "mousein", {
    posxname: "raw_u",
    posyname: "raw_v",
    lbuttonname: "button",
  });
  await builder.python(
    [
      `_m = op(${q(mousein)})`,
      "try:",
      "    _m.par.output = 'normal'",
      "except Exception:",
      "    pass",
    ].join("\n"),
  );

  // Guarantee u/v in [0,1] regardless of Mouse In's raw output range: 'normal' mode is
  // roughly -1..1 (2 units per monitor, centered), so gain=0.5 + offset 0.5 remaps it to
  // 0..1. If a build already emits 0..1, artists can re-tune Sensitivity; this keeps the
  // contract (u,v in [0,1]) true across builds rather than assuming one raw range.
  const normalized = await builder.add("mathCHOP", "normalize_uv", {
    gain: 0.5,
    postoff: 0.5,
  });
  await builder.connect(mousein, normalized);
  const uv = await builder.add("renameCHOP", "uv", { renamefrom: "raw_u raw_v", renameto: "u v" });
  await builder.connect(normalized, uv);

  // Velocity: Slope CHOP differentiates u/v per-sample; rename its outputs to vu/vv so
  // they land as distinct channels once merged with u/v/button.
  const slope = await builder.add("slopeCHOP", "velocity");
  await builder.connect(uv, slope);
  const velocity = await builder.add("renameCHOP", "vuvv", {
    renamefrom: "u v",
    renameto: "vu vv",
  });
  await builder.connect(slope, velocity);

  // Button passes through unchanged from the Mouse In CHOP directly into the merge.
  const merge = await builder.add("mergeCHOP", "merged");
  await builder.connect(uv, merge, 0, 0);
  await builder.connect(velocity, merge, 0, 1);
  await builder.connect(mousein, merge, 0, 2);

  // The rename CHOPs only rename u/v (not the button that rides along from Mouse In),
  // so each input into the merge still carries its own 'button' — and Mouse In also
  // brings its raw_u/raw_v back in. Merging then collision-suffixes the duplicate
  // buttons (button1/button2) and passes raw_u/raw_v through, leaking 4 undocumented
  // channels past the contract. A Select CHOP whitelists exactly the 5 documented
  // channels (channames confirmed live: whitelist keeps u v vu vv button, drops the
  // rest) so the sensitivity gain and the output Null only ever see the 5 bind points.
  const select = await builder.add("selectCHOP", "channels", {
    channames: "u v vu vv button",
  });
  await builder.connect(merge, select);

  const gain = await builder.add("mathCHOP", "sensitivity", { gain: args.sensitivity });
  await builder.connect(select, gain);
  const pointer = await builder.add("nullCHOP", "pointer");
  await builder.connect(gain, pointer);

  // Mouse In only cooks on device events; without something pulling it every frame the
  // whole chain (and especially the Slope-derived velocity) goes stale between events.
  // A tiny Execute DAT force-cooks the Null each frame so u/v/vu/vv/button stay live even
  // before anything is bound to them (mirrors create_motion_reactive's 'cooker' pattern).
  const cooker = await builder.add("executeDAT", "cooker");
  await builder.python(
    `_c = op(${q(cooker)})\n_c.text = "def onFrameStart(frame):\\n\\tparent().op('pointer').cook(force=True)\\n\\treturn\\n"\n_c.par.framestart = True\n_c.par.active = True`,
  );

  return { pointer, gain };
}

/**
 * Builds a small visible demo: a bright circle sprite positioned at the pointer's u/v
 * (remapped 0..1 → -1..1 via Transform TOP tx/ty expressions) composited over a decaying
 * feedback field. A feedbackTOP needs a wired input for its first frame AND forced
 * resolutionw/resolutionh on every node in the loop, or it stays black (see
 * create_feedback_network / create_optical_flow for the same gotcha).
 */
async function buildDemo(
  builder: NetworkBuilder,
  args: CreatePointerReactiveArgs,
  pointerPath: string,
): Promise<string> {
  const [resW, resH] = args.resolution;

  const sprite = await builder.add("circleTOP", "sprite", {
    resolutionw: resW,
    resolutionh: resH,
  });
  const position = await builder.add("transformTOP", "position", {
    resolutionw: resW,
    resolutionh: resH,
  });
  await builder.connect(sprite, position);
  // Remap normalized u/v (0..1) to Transform TOP's centered tx/ty range (-1..1).
  await builder.python(
    [
      `_t = op(${q(position)})`,
      `_t.par.tx.expr = ${q(`2 * op(${q(pointerPath)})['u'] - 1`)}`,
      `_t.par.ty.expr = ${q(`2 * op(${q(pointerPath)})['v'] - 1`)}`,
    ].join("\n"),
  );

  const feedback = await builder.add("feedbackTOP", "trail_fb", {
    resolutionw: resW,
    resolutionh: resH,
  });
  const decay = await builder.add("levelTOP", "trail_decay", {
    opacity: 0.9,
    resolutionw: resW,
    resolutionh: resH,
  });
  await builder.connect(feedback, decay, 0, 0);

  const comp = await builder.add("compositeTOP", "trail_comp", {
    operand: "maximum",
    resolutionw: resW,
    resolutionh: resH,
  });
  await builder.connect(position, comp, 0, 0);
  await builder.connect(decay, comp, 0, 1);
  // Seed the feedback loop's first frame — a feedbackTOP with no wired input never cooks.
  await builder.connect(position, feedback);
  // Close the loop: the feedback TOP samples the composited (sprite + decayed trail) frame.
  await builder.python(`op(${q(feedback)}).par.top = op(${q(comp)}).name`);

  const out = await builder.add("nullTOP", "demo_out");
  await builder.connect(comp, out);
  return out;
}

export async function createPointerReactiveImpl(ctx: ToolContext, args: CreatePointerReactiveArgs) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, "pointer_reactive");
    const { pointer, gain } = await buildPointerChain(builder, args);

    if (args.multitouch) {
      builder.warnings.push(
        "multitouch=true was requested, but true multitouch needs a Panel COMP touch source; " +
          "this build always uses Mouse In (single pointer). Wire a Panel COMP manually for " +
          "multi-finger tracking.",
      );
    }

    let demoOut: string | undefined;
    if (args.demo) {
      demoOut = await buildDemo(builder, args, pointer);
    }

    const controls: ControlSpec[] = [
      {
        name: "Sensitivity",
        type: "float",
        min: 0,
        max: 8,
        default: args.sensitivity,
        bind_to: [`${gain}.gain`],
      },
    ];
    if (args.demo && demoOut) {
      // The decay levelTOP's opacity controls how long the trail persists.
      controls.push({
        name: "Trail",
        type: "float",
        min: 0,
        max: 1,
        default: 0.9,
        bind_to: [`${builder.pathOf("trail_decay")}.opacity`],
      });
    }

    return finalize(ctx, {
      summary:
        `Built a pointer-reactive chain → op('${pointer}') with channels u/v/vu/vv/button. ` +
        `Bind a parameter to op('${pointer}')['u'] / ['v'] / ['button'] / ['vu'] / ['vv'] to ` +
        `make it react to the mouse.` +
        (args.demo && demoOut
          ? ` A demo feedback field at ${demoOut} shows the pointer pushing a trailing dot.`
          : ""),
      builder,
      outputPath: args.demo ? demoOut : pointer,
      // With demo=false the output is a CHOP (no image); with demo=true it's a TOP.
      capturePreviewImage: Boolean(args.demo),
      controls,
      extra: {
        pointer_path: pointer,
        channels: ["u", "v", "vu", "vv", "button"],
        demo: args.demo,
        output_path: args.demo ? demoOut : pointer,
        multitouch_requested: args.multitouch,
        unverified: [
          "mouseinCHOP 'output' menu token 'normal' (set defensively; failure only warns)",
          "mouseinCHOP raw normalized range assumed ~[-1,1] before the 0..1 remap",
        ],
      },
    });
  });
}

export const registerCreatePointerReactive: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_pointer_reactive",
    {
      title: "Create pointer reactive",
      description:
        "Turn mouse/pointer position and click into a first-class creative seed. Builds a " +
        "Mouse In CHOP → normalized u/v (0..1) + velocity (vu/vv) + button, exposed on a " +
        "'pointer' Null CHOP ready for binding: op('…/pointer_reactive/pointer')['u'] / ['v'] / " +
        "['button'] / ['vu'] / ['vv']. A Sensitivity knob gains every channel. By default also " +
        "builds a small visible demo — a bright dot that follows the pointer and leaves a " +
        "decaying trail over a feedback field — so you immediately see it working; set " +
        "demo=false to build only the CHOP chain (no image, no preview). multitouch is " +
        "reserved for a future Panel-COMP touch source; this build always uses Mouse In and " +
        "reports the limitation as a warning when requested. Creates a new baseCOMP under " +
        "`parent_path`. Returns a summary plus a JSON block with the container path, created " +
        "node paths, the pointer Null path, channel names, exposed controls, any node errors, " +
        "and warnings.",
      inputSchema: createPointerReactiveSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createPointerReactiveImpl(ctx, args),
  );
};
