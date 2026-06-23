import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { errorResult, structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { createAsciiRenderImpl, createAsciiRenderSchema } from "./createAsciiRender.js";
import { createAudioReactiveImpl, createAudioReactiveSchema } from "./createAudioReactive.js";
import { createColorGradeImpl, createColorGradeSchema } from "./createColorGrade.js";
import { createDitherImpl, createDitherSchema } from "./createDither.js";
import { createEnergyStructureImpl, createEnergyStructureSchema } from "./createEnergyStructure.js";
import { createFeedbackNetworkImpl, createFeedbackNetworkSchema } from "./createFeedbackNetwork.js";
import { createFeedbackTunnelImpl, createFeedbackTunnelSchema } from "./createFeedbackTunnel.js";
import { createFluidSimImpl, createFluidSimSchema } from "./createFluidSim.js";
import { createGenerativeArtImpl, createGenerativeArtSchema } from "./createGenerativeArt.js";
import { createGlitchImpl, createGlitchSchema } from "./createGlitch.js";
import { createGrowthSystemImpl, createGrowthSystemSchema } from "./createGrowthSystem.js";
import { createHalftoneImpl, createHalftoneSchema } from "./createHalftone.js";
import { createKaleidoscopeImpl, createKaleidoscopeSchema } from "./createKaleidoscope.js";

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
type TargetConfig = {
  impl: TargetImpl;
  schema: z.ZodTypeAny;
  defaults?: Record<string, unknown>;
};

export const APPLY_CREATIVE_CARD_TARGETS: Record<string, TargetConfig> = {
  create_feedback_network: {
    impl: createFeedbackNetworkImpl as TargetImpl,
    schema: createFeedbackNetworkSchema,
  },
  create_audio_reactive: {
    impl: createAudioReactiveImpl as TargetImpl,
    schema: createAudioReactiveSchema,
    defaults: { visual_style: "geometric" },
  },
  create_generative_art: {
    impl: createGenerativeArtImpl as TargetImpl,
    schema: createGenerativeArtSchema,
    defaults: { technique: "noise_landscape" },
  },
  create_kaleidoscope: {
    impl: createKaleidoscopeImpl as TargetImpl,
    schema: createKaleidoscopeSchema,
  },
  create_color_grade: {
    impl: createColorGradeImpl as TargetImpl,
    schema: createColorGradeSchema,
  },
  create_glitch: {
    impl: createGlitchImpl as TargetImpl,
    schema: createGlitchSchema,
  },
  create_halftone: {
    impl: createHalftoneImpl as TargetImpl,
    schema: createHalftoneSchema,
  },
  create_ascii_render: {
    impl: createAsciiRenderImpl as TargetImpl,
    schema: createAsciiRenderSchema,
  },
  create_dither: {
    impl: createDitherImpl as TargetImpl,
    schema: createDitherSchema,
  },
  create_feedback_tunnel: {
    impl: createFeedbackTunnelImpl as TargetImpl,
    schema: createFeedbackTunnelSchema,
  },
  create_fluid_sim: {
    impl: createFluidSimImpl as TargetImpl,
    schema: createFluidSimSchema,
  },
  create_growth_system: {
    impl: createGrowthSystemImpl as TargetImpl,
    schema: createGrowthSystemSchema,
  },
  create_energy_structure: {
    impl: createEnergyStructureImpl as TargetImpl,
    schema: createEnergyStructureSchema,
    defaults: { name: "energy_structure" },
  },
};

export const APPLY_CREATIVE_CARD_DISPATCH: Record<string, TargetImpl> = Object.fromEntries(
  Object.entries(APPLY_CREATIVE_CARD_TARGETS).map(([name, target]) => [name, target.impl]),
);

export const APPLY_CREATIVE_CARD_WHITELIST: ReadonlySet<string> = new Set(
  Object.keys(APPLY_CREATIVE_CARD_TARGETS),
);

function schemaKeys(schema: z.ZodTypeAny): Set<string> | undefined {
  const shape = (schema as z.ZodTypeAny & { shape?: Record<string, unknown> }).shape;
  return shape !== undefined ? new Set(Object.keys(shape)) : undefined;
}

function zodIssues(error: z.ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
}

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

  const target = APPLY_CREATIVE_CARD_TARGETS[name];
  if (!target) {
    // Defensive — set/dispatch table drift would land here.
    return errorResult("Affordance whitelisted but no dispatch entry", { name });
  }

  const overrides = args.overrides ?? {};
  const allowedKeys = schemaKeys(target.schema);
  const unknownKeys =
    allowedKeys !== undefined ? Object.keys(overrides).filter((key) => !allowedKeys.has(key)) : [];
  if (unknownKeys.length > 0) {
    return errorResult("Target args invalid", {
      tool: name,
      unknown_keys: unknownKeys,
      allowed_keys: allowedKeys !== undefined ? Array.from(allowedKeys).sort() : undefined,
    });
  }

  const parsedTargetArgs = target.schema.safeParse({
    ...(target.defaults ?? {}),
    ...overrides,
  });
  if (!parsedTargetArgs.success) {
    return errorResult("Target args invalid", {
      tool: name,
      issues: zodIssues(parsedTargetArgs.error),
    });
  }
  const targetArgs = parsedTargetArgs.data;

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
    result = await target.impl(ctx, targetArgs);
  } catch (err) {
    return errorResult("Target tool failed", { tool: name, error: String(err) });
  }

  const envelope = structuredResult(
    result.isError ? `Target ${name} reported an error` : `Invoked ${name}`,
    {
      card_id: args.card_id,
      tool: name,
      args: targetArgs,
      executed: true,
      result,
      warnings,
    },
  );
  // Propagate the target's failure — otherwise an isError target reads as a
  // successful invocation upstream (MCP clients gate on `isError`, not on the
  // text content).
  if (result.isError === true) {
    envelope.isError = true;
  }
  return envelope;
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
