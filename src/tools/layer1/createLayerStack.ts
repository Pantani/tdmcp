import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { createSystemContainer, finalize, runBuild } from "./orchestration.js";

const q = (value: string): string => JSON.stringify(value);

// Artist-facing blend labels. These are intuitive menu names; the actual TouchDesigner
// Composite TOP `operand` value is looked up in BLEND_OPERAND below (a couple differ —
// "lighten"/"darken" are TD's `lightercolor`/`darkercolor`).
const BLEND = z.enum(["over", "add", "multiply", "screen", "difference", "lighten", "darken"]);
type Blend = z.infer<typeof BLEND>;

// Map each friendly label to a verified Composite TOP `operand` value. `over`, `add`,
// `multiply`, `screen`, `difference` are documented operand names (KB composite_top.json +
// production code); `lighten`/`darken` map to `lightercolor`/`darkercolor`, the real TD
// operand names for per-pixel lighten/darken (the bare words are not valid operands).
const BLEND_OPERAND: Record<Blend, string> = {
  over: "over",
  add: "add",
  multiply: "multiply",
  screen: "screen",
  difference: "difference",
  lighten: "lightercolor",
  darken: "darkercolor",
};

const layerSchema = z.object({
  source: z
    .string()
    .optional()
    .describe("TOP path for this layer. Omit → a built-in test source so it previews."),
  name: z.string().optional().describe("Layer label (defaults to layer1, layer2, …)."),
  blend: BLEND.default("over").describe("Blend mode against the layers below it."),
  opacity: z.coerce.number().min(0).max(1).default(1).describe("Layer opacity 0–1."),
});

export const createLayerStackSchema = z.object({
  name: z.string().default("layer_stack").describe("Name for the compositor COMP."),
  parent_path: z.string().default("/project1").describe("Where to build it."),
  layers: z
    .array(layerSchema)
    .optional()
    .describe("Explicit layer stack (bottom-first). Omit to build `count` empty test layers."),
  count: z
    .number()
    .int()
    .min(2)
    .max(8)
    .default(4)
    .describe("Number of layers when `layers` is omitted."),
  resolution: z
    .tuple([z.number(), z.number()])
    .default([1280, 720])
    .describe("Output resolution [w,h]."),
});
type CreateLayerStackArgs = z.infer<typeof createLayerStackSchema>;
type ResolvedLayer = z.infer<typeof layerSchema>;

// Built-in test sources cycled per layer so an omitted-source stack still previews as a
// readable composite (mirrors createDecks/createLayerMixer's noise/ramp test sources).
const TEST_SOURCES = ["noiseTOP", "rampTOP", "constantTOP", "circleTOP"] as const;

/**
 * Builds the per-layer `Opacity{i}` expression that folds in Mute and Solo. With any Solo
 * armed, only soloed layers pass; Mute always forces 0. Written as a plain Python
 * expression (TD parameter expressions are Python) referencing this container's custom
 * params. UNVERIFIED against a live TD build (see extra.unverified) — built fail-forward so
 * a rejected expression is collected as a warning, never thrown.
 */
function opacityExpr(comp: string, index: number, layerCount: number): string {
  const c = `op(${q(comp)}).par`;
  const anySolo = Array.from({ length: layerCount }, (_, j) => `${c}.Solo${j + 1}`).join(" or ");
  const pass = layerCount > 1 ? `(not (${anySolo}) or ${c}.Solo${index})` : "True";
  // Mute wins; otherwise pass the layer opacity when no solo is armed or this layer is soloed.
  return `0 if ${c}.Mute${index} else (${c}.Opacity${index} if ${pass} else 0)`;
}

/**
 * Python snippet that points one Level's `opacity` at the Mute/Solo expression. Wrapped in
 * its own try/except so a rejected expression on some TD build can never abort the build;
 * ParMode is derived from `type(par.mode)` (not in the bridge exec globals).
 */
function installOpacityExpr(levelPath: string, expr: string): string {
  return [
    "try:",
    `    _p = op(${q(levelPath)}).par.opacity`,
    "    if _p is not None:",
    `        _p.expr = ${q(expr)}`,
    "        _p.mode = type(_p.mode).EXPRESSION",
    "except Exception:",
    "    pass",
  ].join("\n");
}

export async function createLayerStackImpl(ctx: ToolContext, args: CreateLayerStackArgs) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, args.name);
    const [width, height] = args.resolution;

    // Resolve the layer list: an explicit (bottom-first) stack, or `count` empty test layers.
    const layers: ResolvedLayer[] =
      args.layers && args.layers.length > 0
        ? args.layers
        : Array.from({ length: args.count }, () => ({ blend: "over" as Blend, opacity: 1 }));

    const layerInfo: Array<{
      index: number;
      label: string;
      blend: Blend;
      opacity: number;
      source: string;
      level: string;
      external: boolean;
    }> = [];

    let composited = ""; // running output path as we composite bottom → top
    for (const [i, layer] of layers.entries()) {
      const index = i + 1;
      const label = layer.name ?? `layer${index}`;
      const blend = layer.blend ?? "over";
      const opacity = layer.opacity ?? 1;

      // Source: a Select TOP pulling an external TOP (wires don't cross containers), else a
      // cycled built-in test source so the stack previews standalone.
      const external = Boolean(layer.source);
      const source = external
        ? await builder.add("selectTOP", `sel_${index}`, { top: layer.source })
        : await builder.add(TEST_SOURCES[i % TEST_SOURCES.length] as string, `sel_${index}`, {
            outputresolution: "custom",
            resolutionw: width,
            resolutionh: height,
          });

      // Per-layer Level carries opacity; resolution is fixed so every layer composites at the
      // same size. The opacity par is later rewritten to the Mute/Solo expression.
      const level = await builder.add("levelTOP", `lvl_${index}`, {
        opacity,
        outputresolution: "custom",
        resolutionw: width,
        resolutionh: height,
      });
      await builder.connect(source, level);

      if (composited === "") {
        // Bottom layer is the base of the composite.
        composited = level;
      } else {
        // Each layer above the base gets its OWN 2-input Composite TOP so it can carry its
        // own blend mode (a single multi-input Composite shares one operand for all inputs,
        // which would forbid per-layer blends). Input 0 = stack below, input 1 = this layer.
        const comp = await builder.add("compositeTOP", `comp_${index}`, {
          operand: BLEND_OPERAND[blend],
          outputresolution: "custom",
          resolutionw: width,
          resolutionh: height,
        });
        await builder.connect(composited, comp, 0, 0);
        await builder.connect(level, comp, 0, 1);
        composited = comp;
      }

      layerInfo.push({ index, label, blend, opacity, source, level, external });
    }

    // Output Null (ready for post-processing / setup_output).
    const out = await builder.add("nullTOP", "out1");
    if (composited !== "") await builder.connect(composited, out);

    // Per-layer control strip: Opacity / Blend / Mute / Solo. Blend binds the Composite's
    // operand live; Opacity/Mute/Solo carry no bind target because the opacity expression
    // installed below reads them directly.
    const controls: ControlSpec[] = [];
    for (const info of layerInfo) {
      controls.push(
        {
          name: `Opacity${info.index}`,
          label: `${info.label} opacity`,
          type: "float",
          min: 0,
          max: 1,
          default: info.opacity,
          bind_to: [],
        },
        {
          name: `Blend${info.index}`,
          label: `${info.label} blend`,
          type: "menu",
          menu_items: [...BLEND.options],
          default: info.blend,
          // The bottom layer has no Composite, so there is nothing to drive.
          bind_to: info.index === 1 ? [] : [`${builder.containerPath}/comp_${info.index}.operand`],
        },
        { name: `Mute${info.index}`, label: `${info.label} mute`, type: "toggle", bind_to: [] },
        { name: `Solo${info.index}`, label: `${info.label} solo`, type: "toggle", bind_to: [] },
      );
    }

    // Install the Mute/Solo logic: point each Level's `opacity` at an expression that reads
    // this container's Opacity/Mute/Solo custom params. finalize appends those params right
    // after this, in the same build — TD parameter `.expr` is a lazily-evaluated string, so
    // assigning it before the referenced params exist is fine (TD re-cooks once they appear).
    // Fail-forward: builder.python collects any failure as a warning, never throws.
    // UNVERIFIED — TD was offline at build (see extra.unverified).
    for (const info of layerInfo) {
      const expr = opacityExpr(builder.containerPath, info.index, layerInfo.length);
      await builder.python(installOpacityExpr(info.level, expr));
    }

    return finalize(ctx, {
      summary: `Built a ${layers.length}-layer compositor (bottom-up) → ${out}, with per-layer opacity / blend / mute / solo controls.`,
      builder,
      outputPath: out,
      capturePreviewImage: true,
      controls,
      extra: {
        layers: layerInfo.map((info) => ({
          index: info.index,
          name: info.label,
          blend: info.blend,
          operand: BLEND_OPERAND[info.blend],
          opacity: info.opacity,
          source: info.source,
          level: info.level,
          external: info.external,
        })),
        output_path: out,
        resolution: [width, height],
        unverified: [
          "Composite TOP `operand` per-input blend semantics (TD was offline at build).",
          "Per-layer Mute/Solo opacity expression on each lvl_i.opacity — UNVERIFIED against a live TD build.",
        ],
      },
    });
  });
}

export const registerCreateLayerStack: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_layer_stack",
    {
      title: "Create layer stack (N-layer compositor)",
      description:
        "Build a VJ-style N-layer compositor: stack 2–8 source TOPs and composite them bottom-up, each layer with its own blend mode (over/add/multiply/screen/difference/lighten/darken) and opacity. Each layer is a Select TOP (or a built-in test source when omitted) → a Level TOP carrying opacity; layers above the base each get their own 2-input Composite TOP so blend modes are per-layer. Exposes a live control strip — per layer: Opacity (0–1), Blend (menu), Mute, Solo — and ends on a Null ready for post-processing or setup_output. Pass `layers` (bottom-first) for an explicit stack, or omit it to build `count` empty test layers. Returns a summary plus a JSON block with the container path, per-layer node paths, the output Null, exposed controls, node errors, warnings, and an inline preview image.",
      inputSchema: createLayerStackSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createLayerStackImpl(ctx, args),
  );
};
