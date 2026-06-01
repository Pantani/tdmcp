import { z } from "zod";
import { capturePreview } from "../../feedback/previewCapture.js";
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
  system: z
    .string()
    .optional()
    .describe("Optional system instruction (defaults to a TouchDesigner vision-assistant prompt)."),
});
export type CopilotVisionArgs = z.infer<typeof copilotVisionSchema>;

const DEFAULT_SYSTEM =
  "You are a TouchDesigner co-pilot for an artist. Look at the attached frame from a TOP " +
  "and answer the artist's question concisely and concretely. Refer to specific colors, " +
  "shapes, motion cues, and composition you can see. Never invent details the image doesn't show.";

interface CopilotVisionReport {
  source_top: string;
  question: string;
  width: number;
  height: number;
  answer: string;
  model?: string;
  stop_reason?: string;
  warnings: string[];
}

export async function copilotVisionImpl(ctx: ToolContext, args: CopilotVisionArgs) {
  if (!ctx.llm) {
    return errorResult(
      "No LLM backend is configured. Set TDMCP_LLM_BASE_URL + TDMCP_LLM_MODEL (Ollama, OpenAI-compatible, etc.) or run inside an MCP client that supports sampling, then try again.",
    );
  }
  try {
    const preview = await capturePreview(ctx.client, args.source_top, args.width, args.height);
    const warnings: string[] = [];
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
        system: args.system ?? DEFAULT_SYSTEM,
        maxTokens: args.max_tokens,
      },
    );
    const answer = (result.text ?? "").trim();
    if (!answer) {
      warnings.push(
        "Vision LLM returned an empty response — the configured model may not support images.",
      );
    }
    const report: CopilotVisionReport = {
      source_top: preview.path,
      question: args.question,
      width: preview.width,
      height: preview.height,
      answer: answer || "(no answer)",
      warnings,
    };
    if (result.model) report.model = result.model;
    if (result.stopReason) report.stop_reason = result.stopReason;
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
        "Capture a TOP as a preview image and ask the configured multimodal LLM a question about it. Returns `{source_top, question, width, height, answer, model?, stop_reason?, warnings[]}`. Uses ctx.llm.complete() with a MultimodalMessage (text + image part). Requires an LLM backend (TDMCP_LLM_BASE_URL / MCP sampling); returns a friendly error otherwise. Different from `caption_top`, which is deterministic-by-default — this tool ALWAYS routes through the vision model with the artist's custom question.",
      inputSchema: copilotVisionSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    (args) => copilotVisionImpl(ctx, args),
  );
};
