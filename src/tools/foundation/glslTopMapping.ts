import { z } from "zod";
import {
  createSystemContainer,
  finalize,
  type NetworkBuilder,
  runBuild,
} from "../layer1/orchestration.js";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import { errorResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types — see spec §3.1
// ─────────────────────────────────────────────────────────────────────────────

export type ShaderDialect = "shadertoy" | "isf" | "raw";

export interface GlslUniformBinding {
  name: string;
  kind: "float" | "vec" | "color";
  value?: number | number[];
  expr?: string | string[];
}

export type GlslChannelPlaceholder =
  | { kind: "noise"; resolution?: [number, number] }
  | { kind: "ramp"; resolution?: [number, number] }
  | { kind: "constant"; color?: [number, number, number, number] };

export interface GlslChannelInput {
  index: number;
  source: string | GlslChannelPlaceholder;
  filter?: "nearest" | "linear" | "mipmap";
  extend?: "hold" | "zero" | "repeat" | "mirror";
}

export type GlslControlSpec = ControlSpec;

export interface ShaderProvenance {
  dialect: ShaderDialect;
  sourceUrl?: string;
  sourceTitle?: string;
  sourceAuthor?: string;
  license?: string;
}

export interface GlslTopMapping {
  fragment: string;
  uniforms: GlslUniformBinding[];
  channels: GlslChannelInput[];
  controls: GlslControlSpec[];
  provenance: ShaderProvenance;
  warnings: string[];
}

/** Structural ISF INPUT entry — see https://isf.video docs for full schema. */
export interface IsfInput {
  NAME: string;
  TYPE: "float" | "long" | "bool" | "color" | "point2D" | "event" | "image";
  LABEL?: string;
  DEFAULT?: number | boolean | number[] | string;
  MIN?: number | number[];
  MAX?: number | number[];
  VALUES?: number[];
  LABELS?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Zod schemas (spec §3.4)
// ─────────────────────────────────────────────────────────────────────────────

const channelPlaceholderSchema: z.ZodType<GlslChannelPlaceholder> = z.union([
  z.object({
    kind: z.literal("noise"),
    resolution: z.tuple([z.number(), z.number()]).optional(),
  }),
  z.object({
    kind: z.literal("ramp"),
    resolution: z.tuple([z.number(), z.number()]).optional(),
  }),
  z.object({
    kind: z.literal("constant"),
    color: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
  }),
]);

export const glslChannelInputSchema: z.ZodType<GlslChannelInput> = z.object({
  index: z.number().int().min(0).max(3),
  source: z.union([z.string(), channelPlaceholderSchema]),
  filter: z.enum(["nearest", "linear", "mipmap"]).optional(),
  extend: z.enum(["hold", "zero", "repeat", "mirror"]).optional(),
});

export const glslUniformBindingSchema: z.ZodType<GlslUniformBinding> = z.object({
  name: z.string().min(1),
  kind: z.enum(["float", "vec", "color"]),
  value: z.union([z.number(), z.array(z.number())]).optional(),
  expr: z.union([z.string(), z.array(z.string())]).optional(),
});

const controlSpecSchema: z.ZodType<GlslControlSpec> = z.object({
  name: z.string(),
  type: z.enum(["float", "int", "toggle", "menu", "rgb", "pulse", "string"]).default("float"),
  label: z.string().optional(),
  min: z.coerce.number().optional(),
  max: z.coerce.number().optional(),
  default: z.union([z.number(), z.boolean(), z.string()]).optional(),
  menu_items: z.array(z.string()).optional(),
  bind_to: z.array(z.string()).optional(),
});

const provenanceSchema: z.ZodType<ShaderProvenance> = z.object({
  dialect: z.enum(["shadertoy", "isf", "raw"]),
  sourceUrl: z.string().optional(),
  sourceTitle: z.string().optional(),
  sourceAuthor: z.string().optional(),
  license: z.string().optional(),
});

export const glslTopMappingSchema: z.ZodType<GlslTopMapping> = z.object({
  fragment: z.string(),
  uniforms: z.array(glslUniformBindingSchema),
  channels: z.array(glslChannelInputSchema),
  controls: z.array(controlSpecSchema),
  provenance: provenanceSchema,
  warnings: z.array(z.string()),
});

// ─────────────────────────────────────────────────────────────────────────────
// Pure translation helpers (spec §3.2)
// ─────────────────────────────────────────────────────────────────────────────

const SHADERTOY_UNIFORM_DECLS = [
  "uniform float iTime;",
  "uniform float iTimeDelta;",
  "uniform int iFrame;",
  "uniform vec3 iResolution;",
  "uniform vec4 iMouse;",
  "uniform vec4 iDate;",
  "uniform sampler2D iChannel0;",
  "uniform sampler2D iChannel1;",
  "uniform sampler2D iChannel2;",
  "uniform sampler2D iChannel3;",
];

/**
 * Wraps a Shadertoy fragment so it compiles in a TD GLSL TOP. See spec §3.2.
 */
export function mapShadertoyMainImageToFragment(shadertoyFragment: string): {
  fragment: string;
  warnings: string[];
  declaredUniforms: string[];
} {
  const warnings: string[] = [];
  let body = shadertoyFragment;

  // 5. Strip #version and precision lines (TD prepends its own preamble).
  body = body.replace(/^\s*#version[^\n]*\n/gm, "");
  body = body.replace(/^\s*precision\s+[^\n;]*;[\s]*\n?/gm, "");

  // 1. Rename mainImage signature → main() and inject fragCoord.
  // Permissive regex: matches `void mainImage ( out vec4 NAME , in vec2 NAME2 )` w/ optional `inout`.
  const mainImageRe =
    /void\s+mainImage\s*\(\s*(?:in)?\s*(?:out|inout)\s+vec4\s+(\w+)\s*,\s*(?:in\s+)?vec2\s+(\w+)\s*\)\s*\{/m;
  const match = mainImageRe.exec(body);
  let fragColorName = "fragColor";
  if (match) {
    fragColorName = match[1] ?? "fragColor";
    const fragCoordName = match[2] ?? "fragCoord";
    body = body.replace(
      mainImageRe,
      `void main() {\n  vec2 ${fragCoordName} = vUV.st * iResolution.xy;\n`,
    );
  } else if (/void\s+main\s*\(\s*\)\s*\{/.test(body)) {
    warnings.push("Fragment already declares `void main()` — using as-is.");
  } else {
    warnings.push("Could not find Shadertoy `mainImage` signature; emitted a passthrough wrapper.");
    body = `${body}\nvoid main() {\n  fragColor = TDOutputSwizzle(vec4(0.0));\n}\n`;
  }

  // 3. Wrap last fragColor assignment with TDOutputSwizzle.
  if (!/TDOutputSwizzle\s*\(/.test(body)) {
    const assignRe = new RegExp(
      `(${fragColorName}\\s*=\\s*)([^;]+);(?![\\s\\S]*${fragColorName}\\s*=)`,
      "m",
    );
    if (assignRe.test(body)) {
      body = body.replace(assignRe, `$1TDOutputSwizzle($2);`);
    } else {
      warnings.push("Could not locate final fragColor assignment; appending swizzle wrap.");
      body = body.replace(/\}\s*$/, `  ${fragColorName} = TDOutputSwizzle(${fragColorName});\n}\n`);
    }
  }

  // 2. Inject `out vec4 fragColor;` if missing, plus 4. uniform declarations.
  const declared: string[] = [];
  const prefixLines: string[] = [];
  if (!/^\s*out\s+vec4\s+\w+\s*;/m.test(body)) {
    prefixLines.push(`out vec4 ${fragColorName};`);
  }
  for (const decl of SHADERTOY_UNIFORM_DECLS) {
    const m = /uniform\s+\S+\s+(\w+)\s*;/.exec(decl);
    const name = m?.[1];
    if (!name) continue;
    const present = new RegExp(`uniform\\s+\\S+\\s+${name}\\b`).test(body);
    if (!present) {
      prefixLines.push(decl);
      declared.push(name);
    }
  }

  const fragment = `${prefixLines.join("\n")}\n${body}`.replace(/\n{3,}/g, "\n\n");
  return { fragment, warnings, declaredUniforms: declared };
}

/** Spec §3.2 — Shadertoy default uniform bindings. */
export function shadertoyDefaultUniforms(opts?: {
  exposeSpeedControl?: boolean;
  exposeMouseControl?: boolean;
}): GlslUniformBinding[] {
  const speed = opts?.exposeSpeedControl ?? true;
  const mouse = opts?.exposeMouseControl ?? false;
  const speedExpr = speed ? "absTime.seconds * parent().par.Speed.eval()" : "absTime.seconds";
  const mouseExpr = mouse
    ? [
        "parent().par.Mousex.eval()",
        "parent().par.Mousey.eval()",
        "parent().par.Mouseclickx.eval()",
        "parent().par.Mouseclicky.eval()",
      ]
    : ["0.0", "0.0", "0.0", "0.0"];
  return [
    { name: "iTime", kind: "float", expr: speedExpr },
    { name: "iTimeDelta", kind: "float", expr: "1.0 / max(1.0, me.time.rate)" },
    { name: "iFrame", kind: "float", expr: "absTime.frame" },
    {
      name: "iResolution",
      kind: "vec",
      expr: ["op('glsl1').par.resolutionw", "op('glsl1').par.resolutionh", "1.0"],
    },
    { name: "iMouse", kind: "vec", expr: mouseExpr },
    {
      name: "iDate",
      kind: "vec",
      expr: [
        "__import__('datetime').datetime.now().year",
        "__import__('datetime').datetime.now().month",
        "__import__('datetime').datetime.now().day",
        "(__import__('datetime').datetime.now().hour*3600 + __import__('datetime').datetime.now().minute*60 + __import__('datetime').datetime.now().second)",
      ],
    },
  ];
}

/** Spec §3.2 — ISF inputs → uniform bindings + matching control specs + channels. */
export function mapIsfInputsToBindings(isfInputs: ReadonlyArray<IsfInput>): {
  uniforms: GlslUniformBinding[];
  controls: GlslControlSpec[];
  channels: GlslChannelInput[];
  warnings: string[];
} {
  const uniforms: GlslUniformBinding[] = [];
  const controls: GlslControlSpec[] = [];
  const channels: GlslChannelInput[] = [];
  const warnings: string[] = [];
  let imageIndex = 0;

  for (const input of isfInputs) {
    const name = input.NAME;
    const label = input.LABEL ?? name;
    const controlName = name.charAt(0).toUpperCase() + name.slice(1);
    switch (input.TYPE) {
      case "float": {
        const dflt = typeof input.DEFAULT === "number" ? input.DEFAULT : 0;
        uniforms.push({
          name,
          kind: "float",
          expr: `parent().par.${controlName}.eval()`,
        });
        controls.push({
          name: controlName,
          type: "float",
          label,
          default: dflt,
          min: typeof input.MIN === "number" ? input.MIN : undefined,
          max: typeof input.MAX === "number" ? input.MAX : undefined,
          bind_to: [`glsl1.par${controlName}`],
        });
        break;
      }
      case "long": {
        const dflt = typeof input.DEFAULT === "number" ? input.DEFAULT : 0;
        uniforms.push({
          name,
          kind: "float",
          expr: `parent().par.${controlName}.eval()`,
        });
        controls.push({
          name: controlName,
          type: "int",
          label,
          default: dflt,
          min: typeof input.MIN === "number" ? input.MIN : undefined,
          max: typeof input.MAX === "number" ? input.MAX : undefined,
          bind_to: [`glsl1.par${controlName}`],
        });
        break;
      }
      case "bool": {
        const dflt = typeof input.DEFAULT === "boolean" ? input.DEFAULT : false;
        uniforms.push({
          name,
          kind: "float",
          expr: `float(parent().par.${controlName}.eval())`,
        });
        controls.push({
          name: controlName,
          type: "toggle",
          label,
          default: dflt,
          bind_to: [`glsl1.par${controlName}`],
        });
        break;
      }
      case "color": {
        const dflt = Array.isArray(input.DEFAULT) ? input.DEFAULT : [1, 1, 1, 1];
        uniforms.push({
          name,
          kind: "color",
          value: dflt,
        });
        const rgbDefault = Array.isArray(input.DEFAULT) ? input.DEFAULT : [1, 1, 1];
        const hex = `#${[rgbDefault[0] ?? 1, rgbDefault[1] ?? 1, rgbDefault[2] ?? 1]
          .map((v) =>
            Math.round(Math.max(0, Math.min(1, v)) * 255)
              .toString(16)
              .padStart(2, "0"),
          )
          .join("")}`;
        controls.push({
          name: controlName,
          type: "rgb",
          label,
          default: hex,
        });
        break;
      }
      case "point2D": {
        const dflt = Array.isArray(input.DEFAULT) ? input.DEFAULT : [0.5, 0.5];
        uniforms.push({
          name,
          kind: "vec",
          expr: [`parent().par.${controlName}x.eval()`, `parent().par.${controlName}y.eval()`],
        });
        controls.push({
          name: `${controlName}x`,
          type: "float",
          label: `${label} X`,
          default: dflt[0] ?? 0.5,
        });
        controls.push({
          name: `${controlName}y`,
          type: "float",
          label: `${label} Y`,
          default: dflt[1] ?? 0.5,
        });
        break;
      }
      case "event": {
        uniforms.push({
          name,
          kind: "float",
          expr: `float(parent().par.${controlName}.eval())`,
        });
        controls.push({
          name: controlName,
          type: "pulse",
          label,
        });
        break;
      }
      case "image": {
        channels.push({
          index: imageIndex,
          source: { kind: "noise" },
        });
        imageIndex += 1;
        break;
      }
      default: {
        warnings.push(`Unsupported ISF input TYPE for "${name}" — skipped.`);
      }
    }
  }

  return { uniforms, controls, channels, warnings };
}

/** Spec §3.2 — ISF macro shim + TD-friendly wrapping. */
export function mapIsfFragmentToFragment(
  isfFragment: string,
  inputs: ReadonlyArray<IsfInput>,
): { fragment: string; warnings: string[] } {
  const warnings: string[] = [];
  let body = isfFragment;
  body = body.replace(/^\s*#version[^\n]*\n/gm, "");
  body = body.replace(/^\s*precision\s+[^\n;]*;[\s]*\n?/gm, "");

  const imageInputs = inputs.filter((i) => i.TYPE === "image");
  // Resolve image-name → iChannelN sampler.
  let shimImageMacros = "";
  imageInputs.forEach((img, i) => {
    shimImageMacros += `#define ${img.NAME} iChannel${i}\n`;
  });

  const shim = [
    "// ISF macro shim (foundation_glsl_top_mapping)",
    "#define IMG_NORM_PIXEL(image, uv) texture(image, uv)",
    "#define IMG_PIXEL(image, uv) texture(image, (uv) / RENDERSIZE)",
    "#define IMG_THIS_PIXEL(image) texture(image, vUV.st)",
    "#define IMG_NORM_THIS_PIXEL(image) texture(image, vUV.st)",
    "#define IMG_SIZE(image) RENDERSIZE",
    "#define RENDERSIZE iResolution.xy",
    "#define isf_FragNormCoord vUV.st",
    "uniform vec3 iResolution;",
    "uniform float TIME;",
    "uniform sampler2D iChannel0;",
    "uniform sampler2D iChannel1;",
    "uniform sampler2D iChannel2;",
    "uniform sampler2D iChannel3;",
    shimImageMacros,
  ].join("\n");

  if (!/^\s*out\s+vec4\s+\w+\s*;/m.test(body)) {
    body = `out vec4 fragColor;\n${body}`;
  }

  // Add uniform declarations for non-image inputs (so ISF source compiles).
  const uniformDecls: string[] = [];
  for (const input of inputs) {
    if (input.TYPE === "image" || input.TYPE === "event") continue;
    if (input.TYPE === "bool" || input.TYPE === "float" || input.TYPE === "long") {
      uniformDecls.push(`uniform float ${input.NAME};`);
    } else if (input.TYPE === "color") {
      uniformDecls.push(`uniform vec4 ${input.NAME};`);
    } else if (input.TYPE === "point2D") {
      uniformDecls.push(`uniform vec2 ${input.NAME};`);
    }
  }
  for (const input of inputs) {
    if (input.TYPE === "event") {
      uniformDecls.push(`uniform float ${input.NAME};`);
    }
  }

  // Wrap final assignment in TDOutputSwizzle for TD swap-chain.
  if (!/TDOutputSwizzle\s*\(/.test(body)) {
    const assignRe =
      /(gl_FragColor|fragColor)\s*=\s*([^;]+);(?![\s\S]*(?:gl_FragColor|fragColor)\s*=)/m;
    if (assignRe.test(body)) {
      body = body.replace(assignRe, "fragColor = TDOutputSwizzle($2);");
    } else {
      warnings.push("Could not locate final fragColor assignment in ISF body.");
    }
  }

  const fragment = `${shim}\n${uniformDecls.join("\n")}\n${body}`;
  return { fragment, warnings };
}

// ─────────────────────────────────────────────────────────────────────────────
// Builder helpers (spec §3.3)
// ─────────────────────────────────────────────────────────────────────────────

const q = (value: string): string => JSON.stringify(value);

const UNIFORM_KIND_TO_SEQ: Record<
  GlslUniformBinding["kind"],
  { seq: "vec" | "color"; fields: readonly string[] }
> = {
  float: { seq: "vec", fields: ["valuex"] },
  vec: { seq: "vec", fields: ["valuex", "valuey", "valuez", "valuew"] },
  color: { seq: "color", fields: ["rgbr", "rgbg", "rgbb", "alpha"] },
};

function groupUniformsBySeq(uniforms: ReadonlyArray<GlslUniformBinding>): Array<{
  seq: "vec" | "color";
  items: GlslUniformBinding[];
}> {
  const vec: GlslUniformBinding[] = [];
  const color: GlslUniformBinding[] = [];
  for (const u of uniforms) {
    if (UNIFORM_KIND_TO_SEQ[u.kind].seq === "color") color.push(u);
    else vec.push(u);
  }
  const out: Array<{ seq: "vec" | "color"; items: GlslUniformBinding[] }> = [];
  if (vec.length) out.push({ seq: "vec", items: vec });
  if (color.length) out.push({ seq: "color", items: color });
  return out;
}

export async function buildGlslTopSkeleton(
  builder: NetworkBuilder,
  opts: {
    name?: string;
    fragment: string;
    resolution: [number, number];
    pixelFormat?: "rgba8" | "rgba16" | "rgba32";
  },
): Promise<{ glslPath: string; fragDatPath: string; outputPath: string }> {
  const name = opts.name ?? "glsl1";
  const fragName = `${name}_frag`;
  const outName = "out1";
  const fragDatPath = await builder.add("textDAT", fragName);
  const glslPath = await builder.add("glslTOP", name, {
    resolutionw: opts.resolution[0],
    resolutionh: opts.resolution[1],
    format: opts.pixelFormat ?? "rgba8",
  });
  await builder.python(
    `op(${q(fragDatPath)}).text = ${q(opts.fragment)}\nop(${q(glslPath)}).par.pixeldat = op(${q(fragDatPath)}).name`,
  );
  const outputPath = await builder.add("nullTOP", outName);
  await builder.connect(glslPath, outputPath);
  return { glslPath, fragDatPath, outputPath };
}

export async function writeUniformSequences(
  builder: NetworkBuilder,
  glslPath: string,
  uniforms: ReadonlyArray<GlslUniformBinding>,
): Promise<void> {
  for (const group of groupUniformsBySeq(uniforms)) {
    await builder.python(
      `_seq = op(${q(glslPath)}).seq.${group.seq}\n_seq.numBlocks = max(_seq.numBlocks, ${group.items.length})`,
    );
    for (const [i, u] of group.items.entries()) {
      const params: Record<string, unknown> = { [`${group.seq}${i}name`]: u.name };
      const { fields } = UNIFORM_KIND_TO_SEQ[u.kind];
      const values = Array.isArray(u.value) ? u.value : u.value === undefined ? [] : [u.value];
      for (const [j, field] of fields.entries()) {
        const v = values[j];
        if (v !== undefined) params[`${group.seq}${i}${field}`] = v;
      }
      await builder.setParams(glslPath, params);

      // Expressions: written via Python since updateNodeParameters only takes constants.
      if (u.expr !== undefined) {
        const exprs = Array.isArray(u.expr) ? u.expr : [u.expr];
        for (const [j, field] of fields.entries()) {
          const e = exprs[j];
          if (e === undefined) continue;
          await builder.python(
            `_p = op(${q(glslPath)}).par.${group.seq}${i}${field}\n_p.expr = ${q(e)}\n_p.mode = type(_p.mode).EXPRESSION`,
          );
        }
      }
    }
  }
}

async function createChannelPlaceholder(
  builder: NetworkBuilder,
  placeholder: GlslChannelPlaceholder,
  index: number,
): Promise<string> {
  if (placeholder.kind === "noise") {
    const path = await builder.add("noiseTOP", `ichan${index}_noise`, {
      resolutionw: placeholder.resolution?.[0] ?? 512,
      resolutionh: placeholder.resolution?.[1] ?? 512,
      type: "sparse",
    });
    // PROBE-LIVE: noiseTOP translate.y expr for visible motion.
    await builder.python(
      `_p = op(${q(path)}).par.transy\n_p.expr = ${q("absTime.seconds * 0.1")}\n_p.mode = type(_p.mode).EXPRESSION`,
    );
    return path;
  }
  if (placeholder.kind === "ramp") {
    return builder.add("rampTOP", `ichan${index}_ramp`, {
      resolutionw: placeholder.resolution?.[0] ?? 512,
      resolutionh: placeholder.resolution?.[1] ?? 512,
    });
  }
  const color = placeholder.color ?? [0, 0, 0, 1];
  return builder.add("constantTOP", `ichan${index}_const`, {
    colorr: color[0],
    colorg: color[1],
    colorb: color[2],
    alpha: color[3],
  });
}

export async function wireGlslChannels(
  builder: NetworkBuilder,
  glslPath: string,
  channels: ReadonlyArray<GlslChannelInput>,
): Promise<{ channel: number; sourcePath: string }[]> {
  const resolved: { channel: number; sourcePath: string }[] = [];
  for (const ch of channels) {
    let sourcePath: string;
    if (typeof ch.source === "string") {
      sourcePath = ch.source;
    } else {
      sourcePath = await createChannelPlaceholder(builder, ch.source, ch.index);
    }
    await builder.connect(sourcePath, glslPath, 0, ch.index);
    // PROBE-LIVE: input{N}filter / input{N}extend par names on glslTOP.
    const filterMap: Record<string, string> = {
      nearest: "nearest",
      linear: "linear",
      mipmap: "mipmap",
    };
    const extendMap: Record<string, string> = {
      hold: "hold",
      zero: "zero",
      repeat: "repeat",
      mirror: "mirror",
    };
    const params: Record<string, unknown> = {};
    if (ch.filter) params[`input${ch.index}filter`] = filterMap[ch.filter] ?? ch.filter;
    if (ch.extend) params[`input${ch.index}extend`] = extendMap[ch.extend] ?? ch.extend;
    if (Object.keys(params).length) await builder.setParams(glslPath, params);
    resolved.push({ channel: ch.index, sourcePath });
  }
  return resolved;
}

function resolveControlBindings(
  controls: ReadonlyArray<GlslControlSpec>,
  glslPath: string,
  containerPath: string,
): GlslControlSpec[] {
  return controls.map((c) => ({
    ...c,
    bind_to: c.bind_to?.map((target) => {
      // Translate "glsl1.parX" placeholder prefix to the real glsl path.
      if (target.startsWith("glsl1.")) return `${glslPath}.${target.slice("glsl1.".length)}`;
      if (target.startsWith("container."))
        return `${containerPath}.${target.slice("container.".length)}`;
      return target;
    }),
  }));
}

export async function applyGlslTopMapping(
  builder: NetworkBuilder,
  mapping: GlslTopMapping,
  opts: {
    name?: string;
    resolution: [number, number];
    pixelFormat?: "rgba8" | "rgba16" | "rgba32";
  },
): Promise<{
  glslPath: string;
  outputPath: string;
  resolvedControls: GlslControlSpec[];
}> {
  const skeleton = await buildGlslTopSkeleton(builder, {
    name: opts.name,
    fragment: mapping.fragment,
    resolution: opts.resolution,
    pixelFormat: opts.pixelFormat,
  });
  await writeUniformSequences(builder, skeleton.glslPath, mapping.uniforms);
  await wireGlslChannels(builder, skeleton.glslPath, mapping.channels);
  const resolvedControls = resolveControlBindings(
    mapping.controls,
    skeleton.glslPath,
    builder.containerPath,
  );
  return {
    glslPath: skeleton.glslPath,
    outputPath: skeleton.outputPath,
    resolvedControls,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Sugar helpers (spec §3.3 — applyShadertoyUniforms / buildIsfMapping)
// ─────────────────────────────────────────────────────────────────────────────

export function applyShadertoyUniforms(opts: {
  fragment: string;
  channels?: ReadonlyArray<Partial<GlslChannelInput> & { index: number }>;
  exposeSpeedControl?: boolean;
  exposeMouseControl?: boolean;
  provenance?: ShaderProvenance;
}): GlslTopMapping {
  const exposeSpeed = opts.exposeSpeedControl ?? true;
  const exposeMouse = opts.exposeMouseControl ?? false;
  const translated = mapShadertoyMainImageToFragment(opts.fragment);
  const warnings = [...translated.warnings];

  // Find used iChannelN references so we can default-wire them with noise.
  const usedChannels = new Set<number>();
  for (const m of opts.fragment.matchAll(/iChannel([0-3])/g)) {
    const idx = m[1];
    if (idx !== undefined) usedChannels.add(Number(idx));
  }
  const overrideMap = new Map<number, Partial<GlslChannelInput>>();
  for (const c of opts.channels ?? []) overrideMap.set(c.index, c);

  const channels: GlslChannelInput[] = [];
  const seen = new Set<number>();
  for (const c of opts.channels ?? []) {
    if (seen.has(c.index)) continue;
    seen.add(c.index);
    channels.push({
      index: c.index,
      source: c.source ?? { kind: "noise" },
      filter: c.filter,
      extend: c.extend,
    });
  }
  for (const idx of usedChannels) {
    if (seen.has(idx)) continue;
    channels.push({ index: idx, source: { kind: "noise" } });
  }
  channels.sort((a, b) => a.index - b.index);

  const controls: GlslControlSpec[] = [];
  if (exposeSpeed) {
    controls.push({
      name: "Speed",
      type: "float",
      label: "Speed",
      min: 0,
      max: 4,
      default: 1,
    });
  }
  if (exposeMouse) {
    controls.push(
      { name: "Mousex", type: "float", label: "Mouse X", min: 0, max: 1, default: 0.5 },
      { name: "Mousey", type: "float", label: "Mouse Y", min: 0, max: 1, default: 0.5 },
      { name: "Mouseclickx", type: "float", label: "Mouse Click X", min: 0, max: 1, default: 0 },
      { name: "Mouseclicky", type: "float", label: "Mouse Click Y", min: 0, max: 1, default: 0 },
    );
  }

  return {
    fragment: translated.fragment,
    uniforms: shadertoyDefaultUniforms({
      exposeSpeedControl: exposeSpeed,
      exposeMouseControl: exposeMouse,
    }),
    channels,
    controls,
    provenance: opts.provenance ?? { dialect: "shadertoy" },
    warnings,
  };
}

export function buildIsfMapping(opts: {
  fragment: string;
  inputs: ReadonlyArray<IsfInput>;
  channelOverrides?: ReadonlyArray<Partial<GlslChannelInput> & { index: number }>;
  provenance?: ShaderProvenance;
}): GlslTopMapping {
  const translated = mapIsfFragmentToFragment(opts.fragment, opts.inputs);
  const mapped = mapIsfInputsToBindings(opts.inputs);
  const warnings = [...translated.warnings, ...mapped.warnings];

  const overrideMap = new Map<number, Partial<GlslChannelInput>>();
  for (const c of opts.channelOverrides ?? []) overrideMap.set(c.index, c);
  const channels: GlslChannelInput[] = mapped.channels.map((c) => {
    const override = overrideMap.get(c.index);
    if (!override) return c;
    return {
      index: c.index,
      source: override.source ?? c.source,
      filter: override.filter ?? c.filter,
      extend: override.extend ?? c.extend,
    };
  });

  return {
    fragment: translated.fragment,
    uniforms: mapped.uniforms,
    channels,
    controls: mapped.controls,
    provenance: opts.provenance ?? { dialect: "isf" },
    warnings,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: apply_glsl_top_mapping (spec §4)
// ─────────────────────────────────────────────────────────────────────────────

export const applyGlslTopMappingSchema = z.object({
  mapping: glslTopMappingSchema.describe(
    "Pre-built mapping (fragment + uniforms + channels + controls + provenance).",
  ),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP path where the system container is created."),
  name: z
    .string()
    .default("glsl_mapping")
    .describe("Name of the container COMP created under parent_path."),
  resolution: z
    .tuple([z.number().int(), z.number().int()])
    .default([1280, 720])
    .describe("GLSL TOP output resolution [width, height]."),
  pixel_format: z
    .enum(["rgba8", "rgba16", "rgba32"])
    .default("rgba8")
    .describe("GLSL TOP pixel format."),
  expose_controls: z.boolean().default(true).describe("If false, skip the control panel pass."),
  capture_preview: z
    .boolean()
    .default(true)
    .describe("Capture a preview image of the output TOP after the build."),
});

type ApplyGlslTopMappingArgs = z.infer<typeof applyGlslTopMappingSchema>;

export async function applyGlslTopMappingImpl(ctx: ToolContext, args: ApplyGlslTopMappingArgs) {
  if (!args.mapping.fragment || args.mapping.fragment.trim().length === 0) {
    return errorResult(
      "Cannot apply GLSL TOP mapping: `mapping.fragment` is empty — provide a translated fragment string.",
    );
  }
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, args.name);
    const { glslPath, outputPath, resolvedControls } = await applyGlslTopMapping(
      builder,
      args.mapping,
      { resolution: args.resolution, pixelFormat: args.pixel_format },
    );
    return finalize(ctx, {
      summary: `Built GLSL TOP from ${args.mapping.provenance.dialect} mapping.`,
      builder,
      outputPath,
      controls: args.expose_controls ? resolvedControls : [],
      capturePreviewImage: args.capture_preview,
      extra: {
        glslPath,
        provenance: args.mapping.provenance,
        mappingWarnings: args.mapping.warnings,
      },
    });
  });
}

export const registerApplyGlslTopMapping: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "apply_glsl_top_mapping",
    {
      title: "Apply GLSL TOP mapping",
      description:
        "Build a self-contained GLSL TOP network from a pre-translated mapping (fragment + uniforms + channels + controls). Foundation primitive used by Shadertoy and ISF importers; also reachable directly for power users with a hand-translated fragment.",
      inputSchema: applyGlslTopMappingSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => applyGlslTopMappingImpl(ctx, args),
  );
};
