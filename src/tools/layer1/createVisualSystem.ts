import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { createAudioReactiveImpl } from "./createAudioReactive.js";
import { createFeedbackNetworkImpl } from "./createFeedbackNetwork.js";
import { createGenerativeArtImpl } from "./createGenerativeArt.js";
import { createParticleSystemImpl } from "./createParticleSystem.js";
import { significantTerms } from "./intent.js";
import { buildFromRecipe, finalize, runBuild } from "./orchestration.js";

export const createVisualSystemSchema = z.object({
  description: z.string().min(1).describe("Natural-language description of the visual system."),
  parent_path: z.string().default("/project1"),
  resolution: z.enum(["720p", "1080p", "4K", "custom"]).default("1080p"),
  target_fps: z.coerce.number().positive().default(60),
});
type CreateVisualSystemArgs = z.infer<typeof createVisualSystemSchema>;

type Kind =
  | "audio"
  | "particle"
  | "feedback"
  | "reaction_diffusion"
  | "noise_landscape"
  | "default";

function classify(description: string): { kind: Kind; label: string } {
  const d = description.toLowerCase();
  const has = (...words: string[]) => words.some((w) => d.includes(w));
  if (has("audio", "sound", "music", "beat", "frequenc", "spectrum", "reactive")) {
    return { kind: "audio", label: "audio-reactive" };
  }
  if (has("particle", "swarm", "galaxy", "sparkle", "emitter")) {
    return { kind: "particle", label: "particle" };
  }
  if (has("reaction", "diffusion", "gray-scott", "gray scott")) {
    return { kind: "reaction_diffusion", label: "reaction-diffusion" };
  }
  if (has("landscape", "terrain", "mountain", "heightfield")) {
    return { kind: "noise_landscape", label: "noise landscape" };
  }
  if (has("feedback", "tunnel", "echo", "trail", "infinite", "kaleido")) {
    return { kind: "feedback", label: "feedback" };
  }
  return { kind: "default", label: "generative" };
}

function pickAudioStyle(
  description: string,
): "geometric" | "particle" | "feedback" | "glsl" | "instancing" {
  const d = description.toLowerCase();
  if (d.includes("particle")) return "particle";
  if (d.includes("feedback") || d.includes("tunnel")) return "feedback";
  if (d.includes("geometr") || d.includes("shape")) return "geometric";
  if (d.includes("instanc")) return "instancing";
  return "glsl";
}

function pickEmitter(
  description: string,
): "point" | "line" | "circle" | "sphere" | "mesh" | "image" {
  const d = description.toLowerCase();
  if (d.includes("galaxy") || d.includes("sphere") || d.includes("orbit")) return "sphere";
  if (d.includes("ring") || d.includes("circle")) return "circle";
  if (d.includes("line")) return "line";
  return "point";
}

const COLOR_WORDS: Record<string, string> = {
  red: "#e03030",
  crimson: "#c01040",
  orange: "#ff7a18",
  amber: "#ffb000",
  yellow: "#f5e050",
  gold: "#e8c020",
  green: "#30c050",
  lime: "#9be025",
  teal: "#10b0a0",
  cyan: "#20d0e0",
  blue: "#1840d0",
  navy: "#0a1a66",
  indigo: "#3010a0",
  purple: "#7a20c0",
  violet: "#8a40e0",
  magenta: "#d020a0",
  pink: "#ff60b0",
  white: "#f0f0f0",
  black: "#101015",
};

// Best-effort: pull up to two named colors from the description so a feedback system
// can honor a requested palette instead of rendering grayscale.
function parseColors(description: string): string[] {
  const d = description.toLowerCase();
  const found: string[] = [];
  for (const [word, hex] of Object.entries(COLOR_WORDS)) {
    if (new RegExp(`\\b${word}`).test(d) && !found.includes(hex)) found.push(hex);
    if (found.length >= 2) break;
  }
  return found;
}

function withNote(result: CallToolResult, note: string): CallToolResult {
  return { ...result, content: [{ type: "text", text: note }, ...result.content] };
}

export async function createVisualSystemImpl(ctx: ToolContext, args: CreateVisualSystemArgs) {
  const { kind, label } = classify(args.description);
  const note = `Interpreted "${args.description}" as a ${label} system (target ${args.resolution} @ ${args.target_fps}fps).`;
  ctx.logger.info("create_visual_system classified", { kind, description: args.description });

  switch (kind) {
    case "audio":
      return withNote(
        await createAudioReactiveImpl(ctx, {
          audio_source: "microphone",
          visual_style: pickAudioStyle(args.description),
          frequency_bands: 8,
          beat_detection: true,
          parent_path: args.parent_path,
        }),
        note,
      );
    case "particle":
      return withNote(
        await createParticleSystemImpl(ctx, {
          emitter_shape: pickEmitter(args.description),
          particle_count: 10000,
          forces: ["noise", "gravity"],
          render_style: "sprites",
          lifetime: 3,
          expose_controls: true,
          parent_path: args.parent_path,
        }),
        note,
      );
    case "feedback":
      return withNote(
        await createFeedbackNetworkImpl(ctx, {
          seed_type: "noise",
          transformations: ["blur", "displace", "level"],
          feedback_gain: 0.95,
          colors: parseColors(args.description),
          expose_controls: true,
          parent_path: args.parent_path,
        }),
        note,
      );
    case "reaction_diffusion":
    case "noise_landscape":
      return withNote(
        await createGenerativeArtImpl(ctx, {
          technique: kind,
          evolution_speed: 1.0,
          parent_path: args.parent_path,
        }),
        note,
      );
    default: {
      // Try to match a recipe by keywords before falling back to generative GLSL.
      const recipe = ctx.recipes.findByTags(significantTerms(args.description));
      if (recipe) {
        return runBuild(async () => {
          const { builder, outputPath } = await buildFromRecipe(ctx, recipe, args.parent_path);
          return withNote(
            await finalize(ctx, {
              summary: `Built "${recipe.name}" from a matching recipe.`,
              builder,
              outputPath,
              recipeId: recipe.id,
            }),
            note,
          );
        });
      }
      return withNote(
        await createGenerativeArtImpl(ctx, {
          technique: "custom_glsl",
          evolution_speed: 1.0,
          parent_path: args.parent_path,
        }),
        note,
      );
    }
  }
}

export const registerCreateVisualSystem: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_visual_system",
    {
      title: "Create visual system",
      description:
        "Create a complete visual system from a natural-language description. Classifies intent (audio-reactive, particle, feedback, reaction-diffusion, landscape, generative) and builds it in a self-contained COMP, then verifies and previews it.",
      inputSchema: createVisualSystemSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createVisualSystemImpl(ctx, args),
  );
};
