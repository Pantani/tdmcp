import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import {
  createHandGestureBusImpl,
  createHandGestureBusSchema,
} from "../layer2/createHandGestureBus.js";
import { createSystemContainer, finalize, runBuild } from "../layer2/orchestration.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const q = (value: string): string => JSON.stringify(value);

const HOLOGRAM_PRESETS = ["holo_cube", "energy_orb", "wireframe_hud", "particle_core"] as const;
const AUDIO_MODES = ["none", "synth", "device_out"] as const;
const HEX_COLOR = /^#?([0-9a-fA-F]{6})$/;

const HOLO_CUBE_SHADER = `out vec4 fragColor;
uniform vec2 uCenter;
uniform float uSize;
uniform float uOn;
uniform float uRot;
uniform float uGlow;
uniform float uScanline;
uniform float uAlpha;
uniform float uAudio;
uniform vec3 uColor;
uniform vec3 uAccent;

mat2 rot2(float a){
  float c = cos(a);
  float s = sin(a);
  return mat2(c, -s, s, c);
}

float box2(vec2 p, vec2 b){
  vec2 d = abs(p) - b;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}

void main(){
  vec2 uv = vUV.st;
  vec2 p = (uv - uCenter) / max(uSize, 0.0005);
  p = rot2(uRot) * p;
  vec2 p2 = rot2(-uRot * 0.62 + 0.7) * (p + vec2(0.18, -0.12));
  float front = abs(box2(p, vec2(0.52)));
  float back = abs(box2(p2, vec2(0.42)));
  float diagonals = min(abs(p.x - p2.x), abs(p.y - p2.y));
  float edge = min(min(front, back), diagonals);
  float wire = smoothstep(0.045, 0.0, edge);
  float core = smoothstep(0.72, 0.06, max(abs(p.x), abs(p.y))) * 0.18;
  float scan = 0.55 + 0.45 * sin((uv.y - uCenter.y) * 900.0 + uRot * 9.0);
  float scanMix = mix(1.0, scan, clamp(uScanline, 0.0, 1.0));
  float halo = smoothstep(1.35, 0.0, length(p)) * clamp(uGlow / 36.0, 0.0, 2.4);
  float shimmer = 0.78 + 0.22 * sin(uRot * 11.0 + uv.x * 80.0 + uv.y * 47.0);
  vec3 col = mix(uColor, uAccent, clamp(back * 8.0 + uAudio * 0.35, 0.0, 1.0));
  float visibility = clamp(uOn, 0.0, 1.0);
  float alpha = clamp((wire * shimmer + core + halo * 0.22) * visibility * uAlpha, 0.0, 1.0);
  vec3 rgb = col * (wire * 1.8 + core + halo * 0.9) * scanMix * (0.8 + uAudio * 0.45) * visibility;
  fragColor = TDOutputSwizzle(vec4(rgb, alpha));
}
`;

type HologramPreset = (typeof HOLOGRAM_PRESETS)[number];

const PRESET_SHADER: Record<HologramPreset, string> = {
  holo_cube: HOLO_CUBE_SHADER,
  energy_orb: HOLO_CUBE_SHADER,
  wireframe_hud: HOLO_CUBE_SHADER,
  particle_core: HOLO_CUBE_SHADER,
};

export const createHandHologramSchema = z.object({
  source: z.enum(["synthetic", "mediapipe", "existing_chop"]).default("synthetic"),
  parent_path: z.string().default("/project1"),
  comp_name: z.string().default("hand_hologram"),
  hand_chop_path: z.string().optional(),
  tox_path: z.string().optional(),
  preset: z.enum(HOLOGRAM_PRESETS).default("holo_cube"),
  color: z.string().default("#54f4ff"),
  accent_color: z.string().default("#b56cff"),
  size: z.coerce.number().positive().default(1.0),
  float_height: z.coerce.number().min(0).max(3).default(1.15),
  transparency: z.coerce.number().min(0).max(1).default(0.46),
  glow: z.coerce.number().min(0).max(64).default(22),
  scanline_amount: z.coerce.number().min(0).max(1).default(0.35),
  rotation_speed: z.coerce.number().min(-4).max(4).default(0.42),
  pinch_scale_amount: z.coerce.number().min(0).max(4).default(1.4),
  audio_mode: z.enum(AUDIO_MODES).default("none"),
  audio_device_hint: z.string().default("UMC202HD"),
  input_top_path: z.string().optional(),
  resolution: z
    .tuple([z.coerce.number().int().positive(), z.coerce.number().int().positive()])
    .default([1280, 720]),
  expose_controls: z.boolean().default(true),
  capture_preview: z.boolean().default(true),
});
type CreateHandHologramArgs = z.infer<typeof createHandHologramSchema>;

function parseHexColor(hex: string): [number, number, number] | undefined {
  const match = HEX_COLOR.exec(hex.trim());
  const group = match?.[1];
  if (!group) return undefined;
  const int = Number.parseInt(group, 16);
  return [((int >> 16) & 0xff) / 255, ((int >> 8) & 0xff) / 255, (int & 0xff) / 255];
}

function chanExpr(gestureBusPath: string, name: string, fallback: number): string {
  return `(float(op(${q(gestureBusPath)})[${q(name)}][0]) if op(${q(
    gestureBusPath,
  )}) is not None and op(${q(gestureBusPath)})[${q(name)}] is not None else ${fallback})`;
}

function parExpr(name: string, fallback: number): string {
  return `(float(parent().par.${name}.eval()) if hasattr(parent().par, ${q(name)}) else ${fallback})`;
}

function colorParExpr(prefix: string, suffix: "r" | "g" | "b", fallback: number): string {
  const par = `${prefix}${suffix}`;
  return `(float(parent().par.${par}.eval()) if hasattr(parent().par, ${q(par)}) else ${fallback})`;
}

function buildDriverScript(
  args: CreateHandHologramArgs,
  glsl: string,
  frag: string,
  shader: string,
  gestureBusPath: string,
  color: [number, number, number],
  accent: [number, number, number],
  audioNodes: { drone?: string; shimmer?: string; deviceOut?: string },
): string {
  const ch = (name: string, fallback: number) => chanExpr(gestureBusPath, name, fallback);
  const size = `${ch("palm_size", 0.11)} * ${parExpr("Size", args.size)} * (1.0 + ${ch(
    "pinch_power",
    0,
  )} * ${parExpr("Pinchscale", args.pinch_scale_amount)})`;
  const centerY = `max(0.02, min(0.98, ${ch("float_y", 0.5)} - (${ch(
    "palm_size",
    0.11,
  )} * ${parExpr("Floatheight", args.float_height)} * 0.18)))`;
  const audioLevel = `${ch("audio_level", 0)} * ${parExpr("Audiolevel", 1)}`;
  const lines = [
    "# HOLOGRAM_DRIVER",
    `GESTURE_BUS = ${q(gestureBusPath)}`,
    `DEVICE_HINT = ${q(args.audio_device_hint)}`,
    `_frag = op(${q(frag)})`,
    `_glsl = op(${q(glsl)})`,
    "if _frag is not None:",
    `    _frag.text = ${q(shader)}`,
    "if _glsl is not None:",
    "    _glsl.par.pixeldat = _frag.name if _frag is not None else ''",
    "    _glsl.seq.vec.numBlocks = max(_glsl.seq.vec.numBlocks, 8)",
    "    _glsl.par.vec0name = 'uCenter'",
    `    _glsl.par.vec0valuex.expr = ${q(ch("float_x", 0.5))}`,
    `    _glsl.par.vec0valuey.expr = ${q(centerY)}`,
    "    _glsl.par.vec1name = 'uSize'",
    `    _glsl.par.vec1valuex.expr = ${q(size)}`,
    "    _glsl.par.vec2name = 'uOn'",
    `    _glsl.par.vec2valuex.expr = ${q(ch("on", 0))}`,
    "    _glsl.par.vec3name = 'uRot'",
    `    _glsl.par.vec3valuex.expr = ${q(
      `absTime.seconds * ${parExpr("Rotationspeed", args.rotation_speed)} + ${ch("palm_rot", 0)}`,
    )}`,
    "    _glsl.par.vec4name = 'uGlow'",
    `    _glsl.par.vec4valuex.expr = ${q(
      `${parExpr("Glow", args.glow)} * ${ch("light_gain", 1)}`,
    )}`,
    "    _glsl.par.vec5name = 'uScanline'",
    `    _glsl.par.vec5valuex.expr = ${q(parExpr("Scanline", args.scanline_amount))}`,
    "    _glsl.par.vec6name = 'uAlpha'",
    `    _glsl.par.vec6valuex.expr = ${q(parExpr("Transparency", args.transparency))}`,
    "    _glsl.par.vec7name = 'uAudio'",
    `    _glsl.par.vec7valuex.expr = ${q(audioLevel)}`,
    "    _glsl.seq.color.numBlocks = max(_glsl.seq.color.numBlocks, 2)",
    "    _glsl.par.color0name = 'uColor'",
    `    _glsl.par.color0rgbr.expr = ${q(colorParExpr("Color", "r", color[0]))}`,
    `    _glsl.par.color0rgbg.expr = ${q(colorParExpr("Color", "g", color[1]))}`,
    `    _glsl.par.color0rgbb.expr = ${q(colorParExpr("Color", "b", color[2]))}`,
    "    _glsl.par.color1name = 'uAccent'",
    `    _glsl.par.color1rgbr.expr = ${q(colorParExpr("Accentcolor", "r", accent[0]))}`,
    `    _glsl.par.color1rgbg.expr = ${q(colorParExpr("Accentcolor", "g", accent[1]))}`,
    `    _glsl.par.color1rgbb.expr = ${q(colorParExpr("Accentcolor", "b", accent[2]))}`,
  ];
  if (audioNodes.drone) {
    lines.push(
      `_drone = op(${q(audioNodes.drone)})`,
      "if _drone is not None:",
      `    _drone.par.amp.expr = ${q(`${audioLevel} * 0.18`)}`,
      `    _drone.par.frequency.expr = ${q(`90.0 + ${ch("pinch_power", 0)} * 120.0`)}`,
    );
  }
  if (audioNodes.shimmer) {
    lines.push(
      `_shimmer = op(${q(audioNodes.shimmer)})`,
      "if _shimmer is not None:",
      `    _shimmer.par.amp.expr = ${q(`${audioLevel} * 0.08`)}`,
      `    _shimmer.par.frequency.expr = ${q(`430.0 + ${ch("pinch_power", 0)} * 340.0`)}`,
    );
  }
  if (audioNodes.deviceOut) {
    lines.push(
      `_audio_out = op(${q(audioNodes.deviceOut)})`,
      "if _audio_out is not None:",
      "    for _par_name in ('device', 'devicename', 'driver'):",
      "        _par = getattr(_audio_out.par, _par_name, None)",
      "        if _par is not None:",
      "            try:",
      "                _par.val = DEVICE_HINT",
      "                break",
      "            except Exception:",
      "                pass",
    );
  }
  return lines.join("\n");
}

function controlsFor(args: CreateHandHologramArgs): ControlSpec[] {
  if (!args.expose_controls) return [];
  return [
    { name: "Size", type: "float", min: 0.1, max: 4, default: args.size },
    { name: "FloatHeight", type: "float", min: 0, max: 3, default: args.float_height },
    { name: "Transparency", type: "float", min: 0, max: 1, default: args.transparency },
    { name: "Glow", type: "float", min: 0, max: 64, default: args.glow },
    { name: "Scanline", type: "float", min: 0, max: 1, default: args.scanline_amount },
    { name: "RotationSpeed", type: "float", min: -4, max: 4, default: args.rotation_speed },
    { name: "PinchScale", type: "float", min: 0, max: 4, default: args.pinch_scale_amount },
    { name: "AudioLevel", type: "float", min: 0, max: 2, default: 1 },
    { name: "Color", type: "rgb", default: args.color },
    { name: "AccentColor", type: "rgb", default: args.accent_color },
  ];
}

export async function createHandHologramImpl(ctx: ToolContext, args: CreateHandHologramArgs) {
  return runBuild(async () => {
    const color = parseHexColor(args.color) ?? [0.329, 0.957, 1.0];
    const accent = parseHexColor(args.accent_color) ?? [0.71, 0.424, 1.0];
    const builder = await createSystemContainer(ctx, args.parent_path, args.comp_name);

    const busResult = await createHandGestureBusImpl(
      ctx,
      createHandGestureBusSchema.parse({
        source: args.source,
        parent_path: builder.containerPath,
        comp_name: "gesture_bus_comp",
        hand_chop_path: args.hand_chop_path,
        tox_path: args.tox_path,
        max_hands: 2,
        coordinate_space: "world",
        expose_controls: args.expose_controls,
      }),
    );
    if (busResult.isError) return busResult;

    const gestureBusPath = `${builder.containerPath}/gesture_bus_comp/gesture_bus`;
    const [width, height] = args.resolution;
    const bg = args.input_top_path
      ? await builder.add("selectTOP", "bg", { top: args.input_top_path })
      : await builder.add("constantTOP", "bg", {
          colorr: 0,
          colorg: 0,
          colorb: 0,
          alpha: 0,
          outputresolution: "custom",
          resolutionw: width,
          resolutionh: height,
        });

    const glsl = await builder.add("glslTOP", "hologram", {
      outputresolution: "custom",
      resolutionw: width,
      resolutionh: height,
    });
    const frag = await builder.add("textDAT", "holo_frag");
    const blur = await builder.add("blurTOP", "glow_blur", { size: args.glow });
    await builder.connect(glsl, blur);
    const glowLevel = await builder.add("levelTOP", "glow_level", { opacity: 0.72 });
    await builder.connect(blur, glowLevel);
    const comp = await builder.add("compositeTOP", "glow_comp", {
      operand: "add",
      outputresolution: "custom",
      resolutionw: width,
      resolutionh: height,
    });
    await builder.connect(bg, comp, 0, 0);
    await builder.connect(glsl, comp, 0, 1);
    await builder.connect(glowLevel, comp, 0, 2);
    const out = await builder.add("nullTOP", "out1");
    await builder.connect(comp, out);

    const audioNodes: string[] = [];
    const audioDriver: { drone?: string; shimmer?: string; deviceOut?: string } = {};
    if (args.audio_mode !== "none") {
      const drone = await builder.add("audiooscillatorCHOP", "audio_drone", {
        wavetype: "sine",
        frequency: 90,
        amp: 0,
      });
      const shimmer = await builder.add("audiooscillatorCHOP", "audio_shimmer", {
        wavetype: "sine",
        frequency: 430,
        amp: 0,
      });
      const merge = await builder.add("mergeCHOP", "audio_merge");
      await builder.connect(drone, merge, 0, 0);
      await builder.connect(shimmer, merge, 0, 1);
      const audioBus = await builder.add("nullCHOP", "audio_bus");
      await builder.connect(merge, audioBus);
      audioNodes.push(drone, shimmer, merge, audioBus);
      audioDriver.drone = drone;
      audioDriver.shimmer = shimmer;
      if (args.audio_mode === "device_out") {
        const deviceOut = await builder.add("audiodeviceoutCHOP", "audio_out");
        await builder.connect(audioBus, deviceOut);
        audioNodes.push(deviceOut);
        audioDriver.deviceOut = deviceOut;
      }
    }

    await builder.python(
      buildDriverScript(
        args,
        glsl,
        frag,
        PRESET_SHADER[args.preset],
        gestureBusPath,
        color,
        accent,
        audioDriver,
      ),
    );

    return finalize(ctx, {
      summary: `Built a hand hologram (${args.preset}, source: ${args.source}) at ${out}. Open palm drives visibility and opposite-hand pinch drives scale/light/audio.`,
      builder,
      outputPath: out,
      capturePreviewImage: args.capture_preview,
      controls: controlsFor(args),
      extra: {
        source: args.source,
        preset: args.preset,
        output_path: out,
        gesture_bus_path: gestureBusPath,
        audio_mode: args.audio_mode,
        audio_nodes: audioNodes,
        color,
        accent_color: accent,
        resolution: args.resolution,
      },
    });
  });
}

export const registerCreateHandHologram: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_hand_hologram",
    {
      title: "Create hand hologram",
      description:
        "Build a palm-anchored hologram visual driven by create_hand_gesture_bus. Defaults to a synthetic previewable holographic cube; open palm controls visibility, the float anchor keeps it above the palm, and opposite-hand pinch drives scale, glow, and optional futuristic synth/device audio.",
      inputSchema: createHandHologramSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createHandHologramImpl(ctx, args),
  );
};
