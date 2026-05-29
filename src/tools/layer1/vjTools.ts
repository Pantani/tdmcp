import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { bindToChannelImpl } from "../layer2/bindToChannel.js";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import { jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { extractAudioFeaturesImpl } from "./extractAudioFeatures.js";
import { createSystemContainer, finalize, type NetworkBuilder, runBuild } from "./orchestration.js";

const q = (value: string): string => JSON.stringify(value);

function jsonFenceData(result: CallToolResult): Record<string, unknown> {
  const text = result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  const match = /```json\n([\s\S]*?)\n```/.exec(text);
  if (!match) return {};
  try {
    return JSON.parse(match[1] as string) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function sourceTop(
  builder: NetworkBuilder,
  name: string,
  path: string | undefined,
  fallback: "noise" | "ramp" = "noise",
): Promise<string> {
  if (path) return builder.add("selectTOP", name, { top: path });
  if (fallback === "ramp") return builder.add("rampTOP", name);
  return builder.add("noiseTOP", name);
}

async function installGlsl(
  builder: NetworkBuilder,
  topPath: string,
  datName: string,
  shader: string,
  uniforms: Array<{ name: string; value: number }> = [],
): Promise<void> {
  const dat = await builder.add("textDAT", datName);
  const lines = [
    `op(${q(dat)}).text = ${q(shader)}`,
    `_g = op(${q(topPath)})`,
    `_g.par.pixeldat = op(${q(dat)}).name`,
  ];
  if (uniforms.length) {
    lines.push(`_g.seq.vec.numBlocks = max(_g.seq.vec.numBlocks, ${uniforms.length})`);
    for (const [i, uniform] of uniforms.entries()) {
      lines.push(`_g.par.vec${i}name = ${q(uniform.name)}`);
      lines.push(`_g.par.vec${i}valuex = ${uniform.value}`);
    }
  }
  await builder.python(lines.join("\n"));
}

export const bindAudioReactiveSchema = z.object({
  targets: z.array(z.string()).min(1).describe("Parameters to bind, each as 'nodePath.parName'."),
  features_chop: z
    .string()
    .optional()
    .describe("Existing audio-features CHOP. When omitted, a new extractor is built first."),
  source: z
    .enum(["device", "file", "oscillator", "existing_chop"])
    .default("device")
    .describe("Audio source used when features_chop is omitted."),
  audio_file_path: z.string().optional(),
  existing_chop_path: z.string().optional(),
  channel: z.enum(["level", "bass", "mid", "treble"]).default("bass"),
  scale: z.coerce.number().default(1),
  offset: z.coerce.number().default(0),
  attack: z.coerce.number().min(0).optional(),
  release: z.coerce.number().min(0).optional(),
  parent_path: z.string().default("/project1"),
});
type BindAudioReactiveArgs = z.infer<typeof bindAudioReactiveSchema>;

export async function bindAudioReactiveImpl(ctx: ToolContext, args: BindAudioReactiveArgs) {
  let features = args.features_chop;
  let extractor: Record<string, unknown> | undefined;
  if (!features) {
    const result = await extractAudioFeaturesImpl(ctx, {
      source: args.source,
      audio_file_path: args.audio_file_path,
      existing_chop_path: args.existing_chop_path,
      bass_hz: 200,
      mid_hz: 1500,
      treble_hz: 4000,
      expose_controls: true,
      parent_path: args.parent_path,
    });
    if (result.isError) return result;
    extractor = jsonFenceData(result);
    features = typeof extractor.features_path === "string" ? extractor.features_path : undefined;
  }
  if (!features) {
    return jsonResult("Audio-reactive binding could not locate a features CHOP.", {
      targets: args.targets,
      extractor,
      warnings: ["extract_audio_features did not return features_path"],
    });
  }
  const binding = await bindToChannelImpl(ctx, {
    targets: args.targets,
    source_chop: features,
    channel: args.channel,
    scale: args.scale,
    offset: args.offset,
    attack: args.attack,
    release: args.release,
  });
  if (binding.isError) return binding;
  return jsonResult(
    `Bound ${args.targets.length} target(s) to audio ${args.channel} via ${features}.`,
    {
      features_chop: features,
      targets: args.targets,
      channel: args.channel,
      extractor,
      binding: jsonFenceData(binding),
    },
  );
}

export const createTransitionSchema = z.object({
  source_a: z.string().optional(),
  source_b: z.string().optional(),
  mode: z.enum(["crossfade", "wipe", "luma"]).default("crossfade"),
  progress: z.coerce.number().min(0).max(1).default(0.5),
  expose_controls: z.boolean().default(true),
  parent_path: z.string().default("/project1"),
});
type CreateTransitionArgs = z.infer<typeof createTransitionSchema>;

const WIPE_SHADER = `out vec4 fragColor;
uniform float uProgress;
void main(){
  vec4 a = texture(sTD2DInputs[0], vUV.st);
  vec4 b = texture(sTD2DInputs[1], vUV.st);
  float edge = smoothstep(uProgress - 0.04, uProgress + 0.04, vUV.x);
  fragColor = TDOutputSwizzle(mix(a, b, edge));
}`;

const LUMA_SHADER = `out vec4 fragColor;
uniform float uProgress;
void main(){
  vec4 a = texture(sTD2DInputs[0], vUV.st);
  vec4 b = texture(sTD2DInputs[1], vUV.st);
  float gate = smoothstep(uProgress - 0.08, uProgress + 0.08, dot(b.rgb, vec3(0.299, 0.587, 0.114)));
  fragColor = TDOutputSwizzle(mix(a, b, gate));
}`;

export async function createTransitionImpl(ctx: ToolContext, args: CreateTransitionArgs) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, "transition");
    const a = await sourceTop(builder, "source_a", args.source_a, "noise");
    const b = await sourceTop(builder, "source_b", args.source_b, "ramp");
    let transition: string;
    const controls: ControlSpec[] = [];
    if (args.mode === "crossfade") {
      transition = await builder.add("crossTOP", "transition", { cross: args.progress });
      await builder.connect(a, transition, 0, 0);
      await builder.connect(b, transition, 0, 1);
      if (args.expose_controls) {
        controls.push({
          name: "Progress",
          type: "float",
          min: 0,
          max: 1,
          default: args.progress,
          bind_to: [`${transition}.cross`],
        });
      }
    } else {
      transition = await builder.add("glslTOP", "transition", {
        outputresolution: "custom",
        resolutionw: 1280,
        resolutionh: 720,
        format: "rgba8fixed",
      });
      await builder.connect(a, transition, 0, 0);
      await builder.connect(b, transition, 0, 1);
      await installGlsl(
        builder,
        transition,
        "transition_frag",
        args.mode === "wipe" ? WIPE_SHADER : LUMA_SHADER,
        [{ name: "uProgress", value: args.progress }],
      );
      if (args.expose_controls) {
        controls.push({
          name: "Progress",
          type: "float",
          min: 0,
          max: 1,
          default: args.progress,
          bind_to: [`${transition}.vec0valuex`],
        });
      }
    }
    const out = await builder.add("nullTOP", "out1");
    await builder.connect(transition, out);
    return finalize(ctx, {
      summary: `Created a ${args.mode} transition ending at ${out}.`,
      builder,
      outputPath: out,
      controls,
      extra: { mode: args.mode, source_a: a, source_b: b, output_path: out },
    });
  });
}

export const createLiveSourceSchema = z.object({
  kind: z.enum(["camera", "ndi", "syphon_spout", "screen", "movie", "noise"]).default("camera"),
  name: z.string().optional().describe("Source/sender name when applicable."),
  file_path: z.string().optional().describe("Movie path when kind='movie'."),
  parent_path: z.string().default("/project1"),
});
type CreateLiveSourceArgs = z.infer<typeof createLiveSourceSchema>;

export async function createLiveSourceImpl(ctx: ToolContext, args: CreateLiveSourceArgs) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, "live_source");
    const parameters: Record<string, unknown> = {};
    let type = "videodeviceinTOP";
    if (args.kind === "ndi") {
      type = "ndiinTOP";
      if (args.name) parameters.sourcename = args.name;
    } else if (args.kind === "syphon_spout") {
      type = "syphonspoutinTOP";
      if (args.name) parameters.servername = args.name;
    } else if (args.kind === "screen") {
      type = "screengrabTOP";
    } else if (args.kind === "movie") {
      type = "moviefileinTOP";
      parameters.play = 1;
      if (args.file_path) parameters.file = args.file_path;
    } else if (args.kind === "noise") {
      type = "noiseTOP";
    }
    const source = await builder.add(type, "source", parameters);
    const out = await builder.add("nullTOP", "out1");
    await builder.connect(source, out);
    return finalize(ctx, {
      summary: `Created ${args.kind} live source ending at ${out}.`,
      builder,
      outputPath: out,
      extra: { kind: args.kind, source_path: source, output_path: out },
    });
  });
}

export const createLayerStackSchema = z.object({
  inputs: z.array(z.string()).default([]),
  blend: z
    .enum(["add", "over", "multiply", "screen", "difference", "hardlight", "glow"])
    .default("over"),
  opacity: z.coerce.number().min(0).max(1).default(1),
  expose_controls: z.boolean().default(true),
  parent_path: z.string().default("/project1"),
});
type CreateLayerStackArgs = z.infer<typeof createLayerStackSchema>;

export async function createLayerStackImpl(ctx: ToolContext, args: CreateLayerStackArgs) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, "layer_stack");
    const sources =
      args.inputs.length > 0
        ? await Promise.all(
            args.inputs.map((input, i) => sourceTop(builder, `layer${i + 1}`, input)),
          )
        : [
            await sourceTop(builder, "layer1", undefined),
            await sourceTop(builder, "layer2", undefined, "ramp"),
          ];
    const composite = await builder.add("compositeTOP", "stack", {
      operand: args.blend,
      opacity: args.opacity,
    });
    for (const [i, source] of sources.entries()) await builder.connect(source, composite, 0, i);
    const out = await builder.add("nullTOP", "out1");
    await builder.connect(composite, out);
    const controls: ControlSpec[] = args.expose_controls
      ? [
          {
            name: "Opacity",
            type: "float",
            min: 0,
            max: 1,
            default: args.opacity,
            bind_to: [`${composite}.opacity`],
          },
        ]
      : [];
    return finalize(ctx, {
      summary: `Created a ${sources.length}-layer ${args.blend} stack ending at ${out}.`,
      builder,
      outputPath: out,
      controls,
      extra: { blend: args.blend, layers: sources, output_path: out },
    });
  });
}

export const createMediaBinSchema = z.object({
  files: z.array(z.string()).default([]),
  parent_path: z.string().default("/project1"),
  expose_controls: z.boolean().default(true),
});
type CreateMediaBinArgs = z.infer<typeof createMediaBinSchema>;

export async function createMediaBinImpl(ctx: ToolContext, args: CreateMediaBinArgs) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, "media_bin");
    const clips: string[] = [];
    const fileList = args.files.length ? args.files : [""];
    for (const [i, file] of fileList.entries()) {
      clips.push(
        await builder.add("moviefileinTOP", `clip${i + 1}`, { play: 1, ...(file ? { file } : {}) }),
      );
    }
    const list = await builder.add("tableDAT", "media_list");
    await builder.python(`op(${q(list)}).text = ${q(["file", ...fileList].join("\n"))}`);
    let output = clips[0] as string;
    const controls: ControlSpec[] = [];
    if (clips.length > 1) {
      const sw = await builder.add("switchTOP", "switch", { index: 0 });
      for (const [i, clip] of clips.entries()) await builder.connect(clip, sw, 0, i);
      output = sw;
      if (args.expose_controls) {
        controls.push({
          name: "Clip",
          type: "int",
          min: 0,
          max: clips.length - 1,
          default: 0,
          bind_to: [`${sw}.index`],
        });
      }
    }
    const out = await builder.add("nullTOP", "out1");
    await builder.connect(output, out);
    return finalize(ctx, {
      summary: `Created a media bin with ${clips.length} clip slot(s) ending at ${out}.`,
      builder,
      outputPath: out,
      controls,
      extra: { files: fileList, clips, output_path: out, media_list: list },
    });
  });
}

export const createKeyerSchema = z.object({
  foreground: z.string().optional(),
  background: z.string().optional(),
  mode: z.enum(["chroma", "rgb", "matte"]).default("chroma"),
  expose_controls: z.boolean().default(false),
  parent_path: z.string().default("/project1"),
});
type CreateKeyerArgs = z.infer<typeof createKeyerSchema>;

export async function createKeyerImpl(ctx: ToolContext, args: CreateKeyerArgs) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, "keyer");
    const fg = await sourceTop(builder, "foreground", args.foreground, "noise");
    const bg = await sourceTop(builder, "background", args.background, "ramp");
    const keyType =
      args.mode === "rgb" ? "rgbkeyTOP" : args.mode === "matte" ? "matteTOP" : "chromakeyTOP";
    const key = await builder.add(keyType, "key");
    await builder.connect(fg, key, 0, 0);
    let output = key;
    if (args.mode !== "matte") {
      const over = await builder.add("compositeTOP", "composite", { operand: "over" });
      await builder.connect(key, over, 0, 0);
      await builder.connect(bg, over, 0, 1);
      output = over;
    } else {
      await builder.connect(bg, key, 0, 1);
    }
    const out = await builder.add("nullTOP", "out1");
    await builder.connect(output, out);
    return finalize(ctx, {
      summary: `Created a ${args.mode} keyer ending at ${out}.`,
      builder,
      outputPath: out,
      extra: { mode: args.mode, foreground: fg, background: bg, output_path: out },
    });
  });
}

export const createDatamoshSchema = z.object({
  input_path: z.string().optional(),
  amount: z.coerce.number().min(0).max(1).default(0.4),
  feedback: z.coerce.number().min(0).max(1).default(0.92),
  expose_controls: z.boolean().default(true),
  parent_path: z.string().default("/project1"),
});
type CreateDatamoshArgs = z.infer<typeof createDatamoshSchema>;

export async function createDatamoshImpl(ctx: ToolContext, args: CreateDatamoshArgs) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, "datamosh");
    const source = await sourceTop(builder, "source", args.input_path, "noise");
    const feedback = await builder.add("feedbackTOP", "feedback", { opacity: args.feedback });
    const driver = await builder.add("noiseTOP", "motion_vectors", { monochrome: 1, period: 18 });
    const displace = await builder.add("displaceTOP", "motion_smear", {
      displaceweight: args.amount,
    });
    await builder.connect(source, displace, 0, 0);
    await builder.connect(driver, displace, 0, 1);
    const comp = await builder.add("compositeTOP", "mosh", { operand: "over" });
    await builder.connect(displace, comp, 0, 0);
    await builder.connect(feedback, comp, 0, 1);
    await builder.connect(comp, feedback);
    const out = await builder.add("nullTOP", "out1");
    await builder.connect(comp, out);
    const controls: ControlSpec[] = args.expose_controls
      ? [
          {
            name: "Amount",
            type: "float",
            min: 0,
            max: 1,
            default: args.amount,
            bind_to: [`${displace}.displaceweight`],
          },
          {
            name: "Feedback",
            type: "float",
            min: 0,
            max: 1,
            default: args.feedback,
            bind_to: [`${feedback}.opacity`],
          },
        ]
      : [];
    return finalize(ctx, {
      summary: `Created a feedback datamosh-style smear ending at ${out}.`,
      builder,
      outputPath: out,
      controls,
      extra: {
        input_path: source,
        output_path: out,
        note: "Visual datamosh-style feedback; not codec bitstream corruption.",
      },
    });
  });
}

export const createDisplacementWarpSchema = z.object({
  source: z.string().optional(),
  displacement: z.string().optional(),
  amount: z.coerce.number().min(0).default(0.2),
  expose_controls: z.boolean().default(true),
  parent_path: z.string().default("/project1"),
});
type CreateDisplacementWarpArgs = z.infer<typeof createDisplacementWarpSchema>;

export async function createDisplacementWarpImpl(
  ctx: ToolContext,
  args: CreateDisplacementWarpArgs,
) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, "displacement_warp");
    const source = await sourceTop(builder, "source", args.source, "ramp");
    const driver = await sourceTop(builder, "driver", args.displacement, "noise");
    const warp = await builder.add("displaceTOP", "warp", { displaceweight: args.amount });
    await builder.connect(source, warp, 0, 0);
    await builder.connect(driver, warp, 0, 1);
    const out = await builder.add("nullTOP", "out1");
    await builder.connect(warp, out);
    const controls: ControlSpec[] = args.expose_controls
      ? [
          {
            name: "Amount",
            type: "float",
            min: 0,
            max: 2,
            default: args.amount,
            bind_to: [`${warp}.displaceweight`],
          },
        ]
      : [];
    return finalize(ctx, {
      summary: `Created a displacement warp ending at ${out}.`,
      builder,
      outputPath: out,
      controls,
      extra: { source, displacement: driver, output_path: out },
    });
  });
}

export const registerBindAudioReactive: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "bind_audio_reactive",
    {
      title: "Bind audio reactive",
      description:
        "One-shot audio reactivity: ensure an audio-features CHOP exists, then bind one or more parameters to level/bass/mid/treble with optional smoothing.",
      inputSchema: bindAudioReactiveSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => bindAudioReactiveImpl(ctx, args),
  );
};

export const registerCreateTransition: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_transition",
    {
      title: "Create transition",
      description:
        "Build a VJ transition between two TOPs: Cross TOP crossfade or GLSL wipe/luma transition, ending in a previewable Null TOP.",
      inputSchema: createTransitionSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createTransitionImpl(ctx, args),
  );
};

export const registerCreateLiveSource: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_live_source",
    {
      title: "Create live source",
      description:
        "Create a live TOP source wrapper for camera, NDI, Syphon/Spout, screen grab, movie, or noise, ending in a stable Null TOP.",
      inputSchema: createLiveSourceSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createLiveSourceImpl(ctx, args),
  );
};

export const registerCreateLayerStack: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_layer_stack",
    {
      title: "Create layer stack",
      description:
        "Composite two or more TOP layers through Select TOPs and a Composite TOP, with an optional Opacity control.",
      inputSchema: createLayerStackSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createLayerStackImpl(ctx, args),
  );
};

export const registerCreateMediaBin: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_media_bin",
    {
      title: "Create media bin",
      description:
        "Create a clip bin from movie file paths: Movie File In TOP slots, an optional Switch TOP selector, a Table DAT manifest, and a Null TOP output.",
      inputSchema: createMediaBinSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createMediaBinImpl(ctx, args),
  );
};

export const registerCreateKeyer: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_keyer",
    {
      title: "Create keyer",
      description:
        "Create a chroma/RGB/matte keying chain with foreground/background Select TOPs and a composited Null TOP output.",
      inputSchema: createKeyerSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createKeyerImpl(ctx, args),
  );
};

export const registerCreateDatamosh: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_datamosh",
    {
      title: "Create datamosh",
      description:
        "Create a datamosh-style feedback smear: source, feedback loop, displacement driver, Composite TOP, and a controllable Null TOP output.",
      inputSchema: createDatamoshSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createDatamoshImpl(ctx, args),
  );
};

export const registerCreateDisplacementWarp: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_displacement_warp",
    {
      title: "Create displacement warp",
      description:
        "Create a TOP displacement warp from a source TOP and optional displacement TOP, ending in a controllable Null TOP output.",
      inputSchema: createDisplacementWarpSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createDisplacementWarpImpl(ctx, args),
  );
};
