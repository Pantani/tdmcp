import { z } from "zod";
import { structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const intensitySchema = z.enum(["subtle", "balanced", "extreme"]);

export const oneSourceFiveWaysSchema = z.object({
  source_path: z
    .string()
    .min(1)
    .describe("TouchDesigner node path, asset id, file path, or package entry to remix."),
  source_summary: z
    .string()
    .optional()
    .describe(
      "Optional description of the source's colors, motion, structure, or performance role.",
    ),
  goal: z
    .string()
    .default("generate five distinct performance-ready variations")
    .describe("Creative objective for the five variants."),
  intensity: intensitySchema
    .default("balanced")
    .describe("How far the variants should diverge from the source."),
  include_tool_steps: z
    .boolean()
    .default(true)
    .describe("Include suggested tdmcp tool steps for each variant."),
});
type OneSourceFiveWaysArgs = z.infer<typeof oneSourceFiveWaysSchema>;

const INTENSITY_COPY: Record<z.infer<typeof intensitySchema>, string> = {
  subtle: "preserve the source identity and adjust one or two parameters at a time",
  balanced: "keep the source readable while changing rhythm, material, and composition",
  extreme: "treat the source as raw material and push it into a new stage language",
};

interface Variation {
  id: string;
  name: string;
  direction: string;
  prompt: string;
  recommended_tools?: string[];
  checkpoints: string[];
}

function buildVariations(args: OneSourceFiveWaysArgs): Variation[] {
  const source = args.source_path;
  const summary = args.source_summary ?? "the observed source";
  const intensity = INTENSITY_COPY[args.intensity];
  const baseTools = ["get_td_node_parameters", "get_preview", "update_td_node_parameters"];
  const variations: Variation[] = [
    {
      id: "colorway",
      name: "Colorway Shift",
      direction: "Re-score the palette and contrast without changing the core silhouette.",
      prompt: `Using ${source} as the source, create a colorway pass that ${intensity}. Start from ${summary}, then build a palette contrast that can read from stage distance.`,
      recommended_tools: [...baseTools, "create_color_grade", "create_palette"],
      checkpoints: [
        "preview still reads as the original source",
        "no crushed blacks or clipped whites",
      ],
    },
    {
      id: "motion",
      name: "Motion Grammar",
      direction: "Change how the source moves, pulses, or breathes against tempo.",
      prompt: `Turn ${source} into a motion-study variant for ${args.goal}. Let the movement be the main edit: timing, amplitude, trails, and phrase changes should define the remix.`,
      recommended_tools: [...baseTools, "create_modulators", "create_envelope_follower"],
      checkpoints: ["motion has a clear loop or phrase", "tempo changes remain controllable"],
    },
    {
      id: "texture",
      name: "Texture Treatment",
      direction:
        "Transform surface quality through noise, displacement, feedback, or shader treatment.",
      prompt: `Make a texture-first variation of ${source}. Keep the composition usable, but rebuild the material feel around grain, interference, displacement, or live shader texture.`,
      recommended_tools: [...baseTools, "apply_post_processing", "edit_shader_live_loop"],
      checkpoints: ["texture detail survives compression", "effect depth is adjustable live"],
    },
    {
      id: "spatial",
      name: "Spatial Reframe",
      direction: "Recompose the source for screens, projection, LED mapping, or depth illusion.",
      prompt: `Reframe ${source} spatially for ${args.goal}. Explore crop, repetition, depth, mapping safety, and screen position while preserving a clean output path.`,
      recommended_tools: [...baseTools, "create_multi_output", "create_mesh_warp"],
      checkpoints: ["safe frame is visible on all outputs", "mapping controls are exposed"],
    },
    {
      id: "performance-cue",
      name: "Performance Cue",
      direction: "Convert the source into a cueable live-show moment with clear operator controls.",
      prompt: `Build a performance-ready cue from ${source}. The result should have a calm state, a build state, and a peak state that can be triggered or morphed during a set.`,
      recommended_tools: [...baseTools, "create_look_bank", "create_cue_sequencer", "narrate_set"],
      checkpoints: ["cue has named states", "operator can recover to a calm look quickly"],
    },
  ];
  if (!args.include_tool_steps) {
    return variations.map(({ recommended_tools: _recommendedTools, ...variation }) => variation);
  }
  return variations;
}

export const oneSourceFiveWaysOutputSchema = z.object({
  source_path: z.string(),
  source_summary: z.string().optional(),
  goal: z.string(),
  intensity: intensitySchema,
  variations: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      direction: z.string(),
      prompt: z.string(),
      recommended_tools: z.array(z.string()).optional(),
      checkpoints: z.array(z.string()),
    }),
  ),
});

export async function oneSourceFiveWaysImpl(_ctx: ToolContext, args: OneSourceFiveWaysArgs) {
  const variations = buildVariations(args);
  return structuredResult(
    `Generated ${variations.length} remix directions for ${args.source_path}.`,
    {
      source_path: args.source_path,
      ...(args.source_summary ? { source_summary: args.source_summary } : {}),
      goal: args.goal,
      intensity: args.intensity,
      variations,
    },
  );
}

export const registerOneSourceFiveWays: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "one_source_five_ways",
    {
      title: "One source five ways",
      description:
        "Turn one source node, asset, or package entry into five deterministic remix briefs: colorway, motion, texture, spatial reframe, and performance cue. Offline/read-only planning tool for agents before mutating TouchDesigner networks.",
      inputSchema: oneSourceFiveWaysSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      outputSchema: oneSourceFiveWaysOutputSchema.shape,
    },
    (args) => oneSourceFiveWaysImpl(ctx, args),
  );
};
