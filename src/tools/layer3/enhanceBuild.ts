import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ZodTypeAny } from "zod";
import { z } from "zod";
import {
  applyPostProcessingImpl,
  applyPostProcessingSchema,
} from "../layer1/applyPostProcessing.js";
import { createColorGradeImpl, createColorGradeSchema } from "../layer1/createColorGrade.js";
import {
  createFeedbackNetworkImpl,
  createFeedbackNetworkSchema,
} from "../layer1/createFeedbackNetwork.js";
import {
  createFeedbackTunnelImpl,
  createFeedbackTunnelSchema,
} from "../layer1/createFeedbackTunnel.js";
import { arrangeNetworkImpl, arrangeNetworkSchema } from "../layer2/arrangeNetwork.js";
import { bindToChannelImpl, bindToChannelSchema } from "../layer2/bindToChannel.js";
import { structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { type ScoreBuildOutput, scoreBuildImpl, scoreBuildSchema } from "./scoreBuild.js";

export const enhanceBuildSchema = z.object({
  scopePath: z
    .string()
    .default("/project1")
    .describe("Network root to enhance. Forwarded to score_build."),
  focusCriterion: z
    .enum(["palette", "motion", "complexity"])
    .optional()
    .describe(
      "When set, the planner targets only this axis. errors/perf are excluded (use summarize_td_errors / optimize_performance).",
    ),
  autoApply: z
    .boolean()
    .default(false)
    .describe(
      "When true, dispatches each proposed call against the allowlisted tools. Default is preview-only because dispatch mutates the TD project.",
    ),
  maxProposals: z
    .number()
    .int()
    .min(1)
    .max(8)
    .default(3)
    .describe("Cap on proposed (and applied) tool calls. Keeps blast radius small."),
  targetFps: z.number().positive().default(60).describe("Forwarded to score_build."),
  rescore: z
    .boolean()
    .default(true)
    .describe(
      "When autoApply=true, re-run score_build after dispatch and include after + delta. Ignored when autoApply=false.",
    ),
});
type EnhanceBuildArgs = z.infer<typeof enhanceBuildSchema>;

type Criterion = "palette" | "motion" | "complexity" | "errors" | "perf";

interface Proposal {
  tool: string;
  args: Record<string, unknown>;
  rationale: string;
  targets: Criterion[];
}

interface AppliedCall {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  error?: string;
  summary?: string;
}

export const enhanceBuildOutputSchema = z.object({
  scopePath: z.string(),
  before: z.unknown(),
  proposals: z.array(z.unknown()),
  applied: z.array(z.unknown()),
  after: z.unknown().optional(),
  delta: z
    .object({
      final: z.number(),
      perCriterion: z.record(z.string(), z.number()),
    })
    .optional(),
  warnings: z.array(z.string()),
});

type AllowEntry = {
  schema: ZodTypeAny;
  impl: (ctx: ToolContext, args: never) => Promise<CallToolResult>;
  summary: string;
};

const ALLOWLIST: Record<string, AllowEntry> = {
  create_color_grade: {
    schema: createColorGradeSchema,
    impl: createColorGradeImpl as AllowEntry["impl"],
    summary:
      "{ parentPath: string, inputTopPath: string, name?: string, lift?, gamma?, gain?, saturation?, contrast?, hueShift? }",
  },
  apply_post_processing: {
    schema: applyPostProcessingSchema,
    impl: applyPostProcessingImpl as AllowEntry["impl"],
    summary:
      "{ parentPath: string, inputTopPath: string, effects: Array<{ kind: string, params?: object }>, name?: string }",
  },
  create_feedback_network: {
    schema: createFeedbackNetworkSchema,
    impl: createFeedbackNetworkImpl as AllowEntry["impl"],
    summary:
      "{ parentPath: string, sourceTopPath: string, name?: string, decay?, blur?, feedback? }",
  },
  create_feedback_tunnel: {
    schema: createFeedbackTunnelSchema,
    impl: createFeedbackTunnelImpl as AllowEntry["impl"],
    summary: "{ parentPath: string, name?: string, sourceTopPath?: string, zoom?, twist?, decay? }",
  },
  bind_to_channel: {
    schema: bindToChannelSchema,
    impl: bindToChannelImpl as AllowEntry["impl"],
    summary:
      "{ sourceChopPath: string, channel: string, targetNodePath: string, parameter: string, scale?, offset? }",
  },
  arrange_network: {
    schema: arrangeNetworkSchema,
    impl: arrangeNetworkImpl as AllowEntry["impl"],
    summary: "{ parentPath: string, spacingX?, spacingY? }",
  },
};

const PLANNER_SYSTEM =
  'You are a senior TouchDesigner live-visuals director. Given a deterministic scorecard for a build and an allowlist of tdmcp tools (name + JSON schema summary), return up to N concrete tool calls that would raise the lowest sub-scores. Output STRICT JSON of the form {"proposals":[{"tool":"…","args":{…},"rationale":"…","targets":["palette"]}]}. Args MUST validate against the listed schema. No prose outside JSON. Never propose tools that mutate beyond the scope path. Never propose more than N calls.';

function stripFences(text: string): string {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) return fence[1].trim();
  return text.trim();
}

function extractJsonObject(text: string): string | null {
  const trimmed = stripFences(text);
  if (trimmed.startsWith("{")) return trimmed;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return null;
}

function summarizeResult(result: CallToolResult): string {
  const first = result.content?.[0];
  if (first && first.type === "text") {
    const t = first.text ?? "";
    return t.length > 120 ? `${t.slice(0, 117)}...` : t;
  }
  return "";
}

function computeDelta(
  before: ScoreBuildOutput,
  after: ScoreBuildOutput,
): { final: number; perCriterion: Record<string, number> } {
  const perCriterion: Record<string, number> = {};
  const keys = new Set([...Object.keys(before.perCriterion), ...Object.keys(after.perCriterion)]);
  for (const k of keys) {
    const b = (before.perCriterion as Record<string, number | undefined>)[k] ?? 0;
    const a = (after.perCriterion as Record<string, number | undefined>)[k] ?? 0;
    perCriterion[k] = a - b;
  }
  return { final: after.final - before.final, perCriterion };
}

export async function enhanceBuildImpl(ctx: ToolContext, args: EnhanceBuildArgs) {
  const warnings: string[] = [];
  const proposals: Proposal[] = [];
  const applied: AppliedCall[] = [];

  const scoreArgs = scoreBuildSchema.parse({
    scopePath: args.scopePath,
    targetFps: args.targetFps,
    llmCritique: false,
  });
  const beforeRes = await scoreBuildImpl(ctx, scoreArgs);
  if (beforeRes.isError) return beforeRes;
  const before = beforeRes.structuredContent as unknown as ScoreBuildOutput;
  for (const w of before.warnings) {
    if (w.includes("Timeline paused")) warnings.push(w);
  }

  if (!ctx.llm) {
    warnings.push("LLM not configured — set TDMCP_LLM_* to use enhance_build.");
    return structuredResult(`enhance_build: no LLM configured (score ${before.final}/100).`, {
      scopePath: args.scopePath,
      before,
      proposals,
      applied,
      warnings,
    });
  }

  const allowlistDescriptor = Object.entries(ALLOWLIST).map(([tool, e]) => ({
    tool,
    schemaSummary: e.summary,
  }));
  const userPayload = {
    scorecard: before,
    allowlist: allowlistDescriptor,
    focusCriterion: args.focusCriterion,
    maxProposals: args.maxProposals,
    scopePath: args.scopePath,
  };

  let rawText = "";
  try {
    const res = await ctx.llm.complete([{ role: "user", content: JSON.stringify(userPayload) }], {
      system: PLANNER_SYSTEM,
      maxTokens: 800,
      temperature: 0.2,
      timeoutMs: 15000,
    });
    rawText = res.text ?? "";
  } catch (err) {
    warnings.push(`LLM planner failed: ${err instanceof Error ? err.message : String(err)}`);
    return structuredResult(`enhance_build: planner unavailable (score ${before.final}/100).`, {
      scopePath: args.scopePath,
      before,
      proposals,
      applied,
      warnings,
    });
  }

  const jsonText = extractJsonObject(rawText);
  if (!jsonText) {
    warnings.push("LLM returned no JSON object — proposals empty.");
    return structuredResult(`enhance_build: no proposals (score ${before.final}/100).`, {
      scopePath: args.scopePath,
      before,
      proposals,
      applied,
      warnings,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    warnings.push(`LLM JSON parse failed: ${err instanceof Error ? err.message : String(err)}`);
    return structuredResult(`enhance_build: malformed plan (score ${before.final}/100).`, {
      scopePath: args.scopePath,
      before,
      proposals,
      applied,
      warnings,
    });
  }

  const rawProposals = Array.isArray((parsed as { proposals?: unknown }).proposals)
    ? ((parsed as { proposals: unknown[] }).proposals as unknown[])
    : [];
  let dropped = 0;
  for (const raw of rawProposals) {
    if (proposals.length >= args.maxProposals) {
      dropped += 1;
      continue;
    }
    if (!raw || typeof raw !== "object") {
      warnings.push("Dropped proposal: not an object.");
      continue;
    }
    const obj = raw as {
      tool?: unknown;
      args?: unknown;
      rationale?: unknown;
      targets?: unknown;
    };
    const toolName = typeof obj.tool === "string" ? obj.tool : "";
    if (!toolName) {
      warnings.push("Dropped proposal: missing tool name.");
      continue;
    }
    const entry = ALLOWLIST[toolName];
    if (!entry) {
      warnings.push(`Dropped off-allowlist proposal: ${toolName}.`);
      continue;
    }
    const candidateArgs =
      obj.args && typeof obj.args === "object" ? (obj.args as Record<string, unknown>) : {};
    const parsedArgs = entry.schema.safeParse(candidateArgs);
    if (!parsedArgs.success) {
      warnings.push(
        `Dropped proposal ${toolName}: args failed schema (${parsedArgs.error.issues[0]?.message ?? "invalid"}).`,
      );
      continue;
    }
    const targetsArr = Array.isArray(obj.targets)
      ? (obj.targets.filter(
          (t): t is Criterion =>
            typeof t === "string" &&
            ["palette", "motion", "complexity", "errors", "perf"].includes(t),
        ) as Criterion[])
      : [];
    proposals.push({
      tool: toolName,
      args: parsedArgs.data as Record<string, unknown>,
      rationale: typeof obj.rationale === "string" ? obj.rationale : "",
      targets: targetsArr,
    });
  }
  if (dropped > 0) {
    warnings.push(`Dropped ${dropped} proposal(s) over maxProposals=${args.maxProposals}.`);
  }

  if (!args.autoApply) {
    return structuredResult(
      `enhance_build: ${proposals.length} proposal(s) (score ${before.final}/100, preview only).`,
      { scopePath: args.scopePath, before, proposals, applied, warnings },
    );
  }

  for (const p of proposals) {
    const entry = ALLOWLIST[p.tool];
    if (!entry) {
      applied.push({ tool: p.tool, args: p.args, ok: false, error: "off-allowlist" });
      continue;
    }
    try {
      const r = await entry.impl(ctx, p.args as never);
      if (r.isError) {
        applied.push({
          tool: p.tool,
          args: p.args,
          ok: false,
          error: summarizeResult(r) || "tool returned isError",
        });
      } else {
        applied.push({ tool: p.tool, args: p.args, ok: true, summary: summarizeResult(r) });
      }
    } catch (err) {
      applied.push({
        tool: p.tool,
        args: p.args,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  let after: ScoreBuildOutput | undefined;
  let delta: { final: number; perCriterion: Record<string, number> } | undefined;
  if (args.rescore) {
    const afterRes = await scoreBuildImpl(ctx, scoreArgs);
    if (afterRes.isError) {
      warnings.push("Rescore failed; after/delta omitted.");
    } else {
      after = afterRes.structuredContent as unknown as ScoreBuildOutput;
      delta = computeDelta(before, after);
    }
  }

  const okCount = applied.filter((a) => a.ok).length;
  const summary = after
    ? `enhance_build: applied ${okCount}/${applied.length}, score ${before.final} → ${after.final}.`
    : `enhance_build: applied ${okCount}/${applied.length} proposal(s) (score ${before.final}/100).`;
  return structuredResult(summary, {
    scopePath: args.scopePath,
    before,
    proposals,
    applied,
    ...(after ? { after } : {}),
    ...(delta ? { delta } : {}),
    warnings,
  });
}

export const registerEnhanceBuild: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "enhance_build",
    {
      title: "Enhance a TouchDesigner build (LLM-planned)",
      description:
        "Run score_build, ask the configured LLM for up to N allowlisted tool calls that would raise the weakest sub-scores, and optionally auto-apply them. autoApply mutates the project and is NOT idempotent (re-runs can stack effects). Allowlist: create_color_grade, apply_post_processing, create_feedback_network, create_feedback_tunnel, bind_to_channel, arrange_network. Returns before/after scores and a dispatch log.",
      inputSchema: enhanceBuildSchema.shape,
      outputSchema: enhanceBuildOutputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => enhanceBuildImpl(ctx, args),
  );
};
