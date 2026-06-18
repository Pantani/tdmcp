import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createAsciiRenderImpl } from "../layer1/createAsciiRender.js";
import { createAudioReactiveImpl } from "../layer1/createAudioReactive.js";
import { createColorGradeImpl } from "../layer1/createColorGrade.js";
import { createDitherImpl } from "../layer1/createDither.js";
import { createEnergyStructureImpl } from "../layer1/createEnergyStructure.js";
import { createFeedbackNetworkImpl } from "../layer1/createFeedbackNetwork.js";
import { createFeedbackTunnelImpl } from "../layer1/createFeedbackTunnel.js";
import { createFluidSimImpl } from "../layer1/createFluidSim.js";
import { createGenerativeArtImpl } from "../layer1/createGenerativeArt.js";
import { createGlitchImpl } from "../layer1/createGlitch.js";
import { createGrowthSystemImpl } from "../layer1/createGrowthSystem.js";
import { createHalftoneImpl } from "../layer1/createHalftone.js";
import { createKaleidoscopeImpl } from "../layer1/createKaleidoscope.js";
import { errorResult, structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

/**
 * `apply_creative_card` — Closes the inspiration → execution loop. Reads a
 * Creative RAG card, picks one of its `tdmcpAffordances` (a tool name), and
 * delegates to that Layer 1 tool's Impl.
 *
 * The dispatch table is hardcoded so the safety surface is explicit: only the
 * Layer 1 builders below are reachable, no escape hatches (no raw exec, no
 * layer3 atomics, no disk-writers). Card affordances that aren't in the table
 * are rejected before the target is ever called.
 */

export const applyCreativeCardSchema = z.object({
  card_id: z.string().min(1).describe("Creative RAG card id (sha256 hex of sourceUrl)."),
  affordance_index: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe("Which affordance to apply when the card lists more than one."),
  overrides: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Optional args merged into the target tool's input; the target's Zod validates."),
  dry_run: z
    .boolean()
    .default(false)
    .describe("When true, return the planned {tool, args} without invoking the target."),
});

export type ApplyCreativeCardArgs = z.infer<typeof applyCreativeCardSchema>;

// Whitelist + dispatch: only Layer 1 builders that genuinely exist in
// `src/tools/layer1/` and that the RAG vocabulary plausibly emits. No raw
// Python, no layer3 atomics, no disk writers.
type TargetImpl = (ctx: ToolContext, args: unknown) => Promise<CallToolResult>;

export const APPLY_CREATIVE_CARD_DISPATCH: Record<string, TargetImpl> = {
  create_feedback_network: createFeedbackNetworkImpl as TargetImpl,
  create_audio_reactive: createAudioReactiveImpl as TargetImpl,
  create_generative_art: createGenerativeArtImpl as TargetImpl,
  create_kaleidoscope: createKaleidoscopeImpl as TargetImpl,
  create_color_grade: createColorGradeImpl as TargetImpl,
  create_glitch: createGlitchImpl as TargetImpl,
  create_halftone: createHalftoneImpl as TargetImpl,
  create_ascii_render: createAsciiRenderImpl as TargetImpl,
  create_dither: createDitherImpl as TargetImpl,
  create_feedback_tunnel: createFeedbackTunnelImpl as TargetImpl,
  create_fluid_sim: createFluidSimImpl as TargetImpl,
  create_growth_system: createGrowthSystemImpl as TargetImpl,
  create_energy_structure: createEnergyStructureImpl as TargetImpl,
};

export const APPLY_CREATIVE_CARD_WHITELIST: ReadonlySet<string> = new Set(
  Object.keys(APPLY_CREATIVE_CARD_DISPATCH),
);

export async function applyCreativeCardImpl(
  ctx: ToolContext,
  rawArgs: ApplyCreativeCardArgs,
): Promise<CallToolResult> {
  const args = applyCreativeCardSchema.parse(rawArgs);
  const warnings: string[] = [];

  if (!ctx.creativeRag) {
    return errorResult("Creative RAG disabled", {
      hint: "Set TDMCP_RAG_ENABLED=1 and TDMCP_RAG_APPLY_CARD=1 to enable.",
    });
  }

  let card: Awaited<ReturnType<typeof ctx.creativeRag.getCard>>;
  try {
    card = await ctx.creativeRag.getCard(args.card_id);
  } catch (err) {
    return errorResult("Failed to load card", {
      card_id: args.card_id,
      error: String(err),
    });
  }
  if (!card) {
    return errorResult("Card not found", { card_id: args.card_id });
  }

  const affordances = card.tdmcpAffordances ?? [];
  if (args.affordance_index >= affordances.length) {
    return errorResult("No affordance at index", {
      available: affordances.length,
      requested: args.affordance_index,
    });
  }
  const name = affordances[args.affordance_index];
  if (!name) {
    return errorResult("No affordance at index", {
      available: affordances.length,
      requested: args.affordance_index,
    });
  }

  if (!APPLY_CREATIVE_CARD_WHITELIST.has(name)) {
    return errorResult("Affordance not whitelisted", {
      name,
      allowed: Array.from(APPLY_CREATIVE_CARD_WHITELIST).sort(),
    });
  }

  const targetImpl = APPLY_CREATIVE_CARD_DISPATCH[name];
  if (!targetImpl) {
    // Defensive — set/dispatch table drift would land here.
    return errorResult("Affordance whitelisted but no dispatch entry", { name });
  }

  const targetArgs = args.overrides ?? {};

  if (args.dry_run) {
    return structuredResult(`Dry run: would invoke ${name}`, {
      card_id: args.card_id,
      tool: name,
      args: targetArgs,
      executed: false,
      warnings,
    });
  }

  let result: CallToolResult;
  try {
    result = await targetImpl(ctx, targetArgs);
  } catch (err) {
    return errorResult("Target tool failed", { tool: name, error: String(err) });
  }

  return structuredResult(result.isError ? `Target ${name} reported an error` : `Invoked ${name}`, {
    card_id: args.card_id,
    tool: name,
    args: targetArgs,
    executed: true,
    result,
    warnings,
  });
}

export const registerApplyCreativeCard: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "apply_creative_card",
    {
      title: "Apply creative card",
      description:
        "Read a Creative RAG card by id, pick one of its `tdmcpAffordances` (a Layer 1 tool name), and route to that tool with optional overrides. Hardcoded whitelist of Layer 1 builders — no raw exec, no atomic layer3 tools. Use `dry_run: true` to preview the plan. Requires Creative RAG enabled (`ctx.creativeRag`) and `TDMCP_RAG_APPLY_CARD=1`.",
      inputSchema: applyCreativeCardSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => applyCreativeCardImpl(ctx, args),
  );
};
