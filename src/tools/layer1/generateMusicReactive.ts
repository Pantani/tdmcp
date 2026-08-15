import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { runGeneration } from "../../ace-client/runGeneration.js";
import { friendlyAceError } from "../../ace-client/types.js";
import {
  type AceToolContext,
  generateMusicSchema,
  runOptions,
  toAceRequest,
} from "../layer3/generateMusic.js";
import { errorResult } from "../result.js";
import type { ToolExtra, ToolRegistrar } from "../types.js";
import { createAudioReactiveImpl, createAudioReactiveSchema } from "./createAudioReactive.js";

/**
 * F2 merges the `generate_music` bed params with a curated subset of the
 * `create_audio_reactive` visual params. The reactive audio-source params
 * (`audio_source`, `audio_file_path`, `existing_chop_path`) are deliberately
 * EXCLUDED — F2 forces `audio_source:"file"` with the freshly generated WAV, so
 * exposing them would let the caller contradict the whole point of the tool.
 * The transient/duck extension params are omitted so the built network is
 * byte-identical to the base reactive build.
 *
 * Fields carry schema defaults, so `z.infer` makes them required after parse;
 * the impl takes `unknown` and `safeParse`s inside (mirrors the two sources).
 */
export const generateMusicReactiveSchema = z.object({
  // --- generation (bed) params: reuse generate_music, minus `mode` (this tool is
  //     definitionally sync — it cannot build the network without the WAV) ---
  ...generateMusicSchema.omit({ mode: true }).shape,
  // --- reactive (visual) params: a curated subset of create_audio_reactive ---
  visual_style: createAudioReactiveSchema.shape.visual_style,
  frequency_bands: createAudioReactiveSchema.shape.frequency_bands,
  beat_detection: createAudioReactiveSchema.shape.beat_detection,
  expose_controls: createAudioReactiveSchema.shape.expose_controls,
  parent_path: createAudioReactiveSchema.shape.parent_path,
});

type GenerationFacts = { wavPath: string; seconds: number; seed: number };

/**
 * Augment the reactive tool's result with the generation facts:
 * - prepend a text line describing the generated bed,
 * - nest `{ wavPath, seconds, seed }` under a `generation` key in
 *   `structuredContent` so it never collides with the reactive tool's own keys,
 * - preserve `isError` and every existing content item (incl. the preview image).
 */
function augmentWithGeneration(reactive: CallToolResult, gen: GenerationFacts): CallToolResult {
  const line = `Generated ${gen.seconds.toFixed(1)}s bed (seed ${gen.seed}) -> ${gen.wavPath}`;
  return {
    ...reactive,
    content: [{ type: "text", text: line }, ...reactive.content],
    structuredContent: {
      ...(reactive.structuredContent ?? {}),
      generation: { wavPath: gen.wavPath, seconds: gen.seconds, seed: gen.seed },
    },
  };
}

export async function generateMusicReactiveImpl(
  ctx: AceToolContext,
  rawArgs: unknown,
  extra?: ToolExtra,
) {
  const parsed = generateMusicReactiveSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return errorResult(
      `Invalid arguments: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    );
  }
  const client = ctx.aceClient;
  if (!client) {
    return errorResult(
      "ACE-Step music generation is disabled. Set TDMCP_ACE_ENABLED=1 (and run the ace/ wrapper) to enable.",
    );
  }
  const a = parsed.data;

  // 1) Generate the bed through the shared driver, forced to the SYNC branch (we
  //    need the WAV to build the network). This is what buys progress notifications
  //    + AbortSignal->cancelJob on the longest-running call in the repo. Do NOT nest
  //    the async reactive build inside guardAce's sync onOk; use an explicit
  //    try/catch so guardAce's shared signature stays untouched and we never throw.
  let gen: GenerationFacts;
  try {
    const outcome = await runGeneration(client, toAceRequest(a), runOptions(client, "sync", extra));
    if (outcome.kind !== "sync") {
      return errorResult(
        "ACE returned a job instead of a WAV; generate_music_reactive needs the audio.",
      );
    }
    gen = outcome.result;
  } catch (err) {
    return errorResult(friendlyAceError(err));
  }

  // 2) Build the reactive network over the generated WAV.
  const reactive = await createAudioReactiveImpl(ctx, {
    audio_source: "file",
    audio_file_path: gen.wavPath,
    visual_style: a.visual_style,
    frequency_bands: a.frequency_bands,
    beat_detection: a.beat_detection,
    expose_controls: a.expose_controls,
    parent_path: a.parent_path,
  });
  // Generation succeeded but the build failed → surface that error as-is.
  if (reactive.isError) return reactive;

  // 3) Augment the reactive result with the generation facts.
  return augmentWithGeneration(reactive, gen);
}

export const registerGenerateMusicReactive: ToolRegistrar = (server, ctx) => {
  if (!ctx.aceClient) return;
  server.registerTool(
    "generate_music_reactive",
    {
      title: "Generate music + audio-reactive visual (ACE-Step)",
      description:
        "Generate a music bed from a text prompt via a local ACE-Step server, then build an " +
        "audio-reactive visual network driven by that generated WAV (spectrum + level + optional beat + " +
        "a GLSL spectrum visual, auto-laid-out with a live Sensitivity control and an inline preview). " +
        "Synchronous end-to-end (generation can take minutes). Requires TDMCP_ACE_ENABLED=1 and a running " +
        "ace/ wrapper. Returns the generation facts plus the built network summary and preview.",
      inputSchema: generateMusicReactiveSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args, extra) => generateMusicReactiveImpl(ctx, args, extra),
  );
};
