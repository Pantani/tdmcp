import { z } from "zod";
import { capturePreview } from "../../feedback/previewCapture.js";
import {
  type CompleteResult,
  LLM_SYSTEM_OPTION,
  type LlmRuntimeDescriptor,
} from "../../llm/client.js";
import { friendlyTdError } from "../../td-client/types.js";
import { errorResult, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

/**
 * `copilot_vision` — route a vision query to the configured multimodal LLM with a
 * TOP rendered as an inline image. Uses the standard `ctx.llm.complete()` path
 * with a `MultimodalMessage` whose content is `[{type:"text", text:question},
 * {type:"image", data:base64, mimeType}]`. Falls back with a clear error when
 * no LLM tier is configured (`ctx.llm` undefined) — pointing the artist at the
 * TDMCP_LLM_* config.
 */

export const copilotVisionSchema = z.object({
  source_top: z.string().describe("Path of the TOP to send to the vision LLM."),
  question: z
    .string()
    .min(1)
    .describe("Question or instruction about the image (e.g. 'what colors dominate?')."),
  width: z.coerce
    .number()
    .int()
    .positive()
    .max(2048)
    .default(640)
    .describe("Width to render the preview at before sending."),
  height: z.coerce
    .number()
    .int()
    .positive()
    .max(2048)
    .default(360)
    .describe("Height to render the preview at before sending."),
  max_tokens: z.coerce
    .number()
    .int()
    .positive()
    .max(4096)
    .default(512)
    .describe("Upper bound on response tokens."),
  allow_remote_image_egress: z
    .boolean()
    .default(false)
    .describe(
      "Explicitly allow this captured frame to leave numeric loopback through a remote OpenAI-compatible endpoint or MCP sampling client. Required for every non-loopback call.",
    ),
  [LLM_SYSTEM_OPTION]: z
    .string()
    .optional()
    .describe("Optional system instruction (defaults to a TouchDesigner vision-assistant prompt)."),
});
export type CopilotVisionArgs = z.infer<typeof copilotVisionSchema>;

const DEFAULT_SYSTEM =
  "You are a TouchDesigner co-pilot for an artist. Look at the attached frame from a TOP " +
  "and answer the artist's question concisely and concretely. Refer to specific colors, " +
  "shapes, motion cues, and composition you can see. Never invent details the image doesn't show.";

function redactedEndpointOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    return parsed.origin;
  } catch {
    return undefined;
  }
}

interface CopilotVisionReport {
  source_top: string;
  question: string;
  width: number;
  height: number;
  answer: string;
  model?: string;
  stop_reason?: string;
  egress: {
    transport: "openai_compatible" | "mcp_sampling" | "unknown";
    locality: "loopback" | "remote" | "client_managed" | "unknown";
    endpoint_origin?: string;
    configured_model?: string;
    remote_consent: "not_required_loopback" | "explicit";
    calibration: "not_checked";
  };
  warnings: string[];
}

type CapturedPreview = Awaited<ReturnType<typeof capturePreview>>;

function visionWarnings(answer: string): string[] {
  if (answer) return [];
  return ["Vision LLM returned an empty response — the configured model may not support images."];
}

function buildVisionReport(
  preview: CapturedPreview,
  args: CopilotVisionArgs,
  descriptor: LlmRuntimeDescriptor,
  endpointOrigin: string | undefined,
  leavesLoopback: boolean,
  result: CompleteResult,
): CopilotVisionReport {
  const answer = (result.text ?? "").trim();
  return {
    source_top: preview.path,
    question: args.question,
    width: preview.width,
    height: preview.height,
    answer: answer || "(no answer)",
    ...(result.model ? { model: result.model } : {}),
    ...(result.stopReason ? { stop_reason: result.stopReason } : {}),
    egress: {
      transport: descriptor.transport,
      locality: descriptor.locality,
      ...(endpointOrigin ? { endpoint_origin: endpointOrigin } : {}),
      ...(descriptor.configuredModel ? { configured_model: descriptor.configuredModel } : {}),
      remote_consent: leavesLoopback ? "explicit" : "not_required_loopback",
      calibration: descriptor.calibration,
    },
    warnings: visionWarnings(answer),
  };
}

export async function copilotVisionImpl(ctx: ToolContext, args: CopilotVisionArgs) {
  if (!ctx.llm) {
    return errorResult(
      "No LLM backend is configured. Set TDMCP_LLM_BASE_URL + TDMCP_LLM_MODEL (Ollama, OpenAI-compatible, etc.) or run inside an MCP client that supports sampling, then try again.",
    );
  }
  const descriptor = ctx.llm.describe?.() ?? {
    transport: "unknown" as const,
    locality: "unknown" as const,
    calibration: "not_checked" as const,
  };
  const endpointOrigin = redactedEndpointOrigin(descriptor.endpointOrigin);
  const leavesLoopback = descriptor.locality !== "loopback";
  if (leavesLoopback && !args.allow_remote_image_egress) {
    return errorResult(
      "Image egress refused: the configured vision backend is remote, client-managed, or unknown. Review the endpoint/provider and retry with allow_remote_image_egress=true for this frame only.",
    );
  }
  try {
    const preview = await capturePreview(ctx.client, args.source_top, args.width, args.height);
    const result = await ctx.llm.complete(
      [
        {
          role: "user",
          content: [
            { type: "text", text: args.question },
            { type: "image", data: preview.base64, mimeType: preview.mimeType },
          ],
        },
      ],
      {
        [LLM_SYSTEM_OPTION]: args[LLM_SYSTEM_OPTION] ?? DEFAULT_SYSTEM,
        maxTokens: args.max_tokens,
      },
    );
    const report = buildVisionReport(
      preview,
      args,
      descriptor,
      endpointOrigin,
      leavesLoopback,
      result,
    );
    return jsonResult(`${preview.path}: ${report.answer.slice(0, 120)}`, report);
  } catch (err) {
    // capturePreview throws TdError on bridge failure; LLM throws on backend failure.
    return errorResult(friendlyTdError(err));
  }
}

export const registerCopilotVision: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "copilot_vision",
    {
      title: "Ask the LLM about a TOP (multimodal)",
      description:
        "Capture a TOP as a preview image and ask the configured multimodal LLM a question about it. Numeric-loopback endpoints need no extra opt-in; remote, client-managed, or unknown backends require `allow_remote_image_egress=true` for that frame. Returns redacted egress locality/transport and `calibration: not_checked`; this read-only tool is NOT the calibrated visual-mutation authority. Uses ctx.llm.complete() with an image part. Different from `caption_top`, which is deterministic-by-default.",
      inputSchema: copilotVisionSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    (args) => copilotVisionImpl(ctx, args),
  );
};
