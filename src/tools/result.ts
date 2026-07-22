import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  friendlyTdError,
  TdApiError,
  TdBackpressureError,
  TdConnectionError,
  TdError,
  TdTimeoutError,
} from "../td-client/types.js";

type Content = CallToolResult["content"];

export function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

/**
 * An `isError` result. When `data` is supplied it is appended as a JSON code
 * fence (mirroring `jsonResult`) so a hard failure can still carry its structured
 * report — the difference from `jsonResult` is that `isError` is set, so the CLI
 * exits non-zero and MCP clients see the failure instead of a false success.
 */
export function errorResult(message: string, data?: unknown): CallToolResult {
  const text =
    data === undefined
      ? message
      : `${message}\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;
  return { isError: true, content: [{ type: "text", text }] };
}

/** A text block followed by a pretty-printed JSON code fence. */
export function jsonResult(summary: string, data: unknown): CallToolResult {
  const text = `${summary}\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;
  return { content: [{ type: "text", text }] };
}

/** Preserve the historic JSON code fence while also exposing the same data structurally. */
export function jsonStructuredResult(summary: string, data: object): CallToolResult {
  return {
    ...jsonResult(summary, data),
    structuredContent: data as { [key: string]: unknown },
  };
}

/**
 * A short text summary plus a machine-readable `structuredContent` payload.
 *
 * Use this (with an `outputSchema` on the tool) for read tools so agents can
 * process the data with code instead of re-parsing a JSON code fence out of the
 * conversation. The text block stays small on purpose — it is only a summary;
 * the full data travels on the `structuredContent` channel.
 */
export function structuredResult(summary: string, data: object): CallToolResult {
  return {
    content: [{ type: "text", text: summary }],
    structuredContent: data as { [key: string]: unknown },
  };
}

/** An image block (base64), optionally preceded by a caption. */
export function imageResult(
  base64: string,
  mimeType = "image/png",
  caption?: string,
): CallToolResult {
  const content: Content = [];
  if (caption) content.push({ type: "text", text: caption });
  content.push({ type: "image", data: base64, mimeType });
  return { content };
}

function apiErrorDetails(error: TdError): Record<string, unknown> {
  if (!(error instanceof TdApiError)) return {};
  const details: Record<string, unknown> = {};
  if (error.apiCode) details.api_code = error.apiCode;
  if (error.status !== undefined) details.status = error.status;
  if (error.details !== undefined) details.details = error.details;
  return details;
}

function backpressureDetails(error: TdError): Record<string, unknown> {
  if (!(error instanceof TdBackpressureError)) return {};
  return { retry_after_ms: Math.max(0, Math.min(60_000, error.retryAfterMs)) };
}

function structuredTdError(error: TdError): Record<string, unknown> {
  return {
    status: "failed",
    error: {
      code: error.code,
      ...apiErrorDetails(error),
      ...backpressureDetails(error),
      ambiguous: error instanceof TdTimeoutError || error instanceof TdConnectionError,
    },
  };
}

/**
 * Runs a client call and formats the result, converting any TD error into a
 * friendly `isError` result instead of throwing out of the MCP handler.
 */
export async function guardTd<T>(
  fn: () => Promise<T>,
  onOk: (value: T) => CallToolResult,
): Promise<CallToolResult> {
  try {
    return onOk(await fn());
  } catch (err) {
    const result = errorResult(friendlyTdError(err));
    if (err instanceof TdError) {
      result.structuredContent = structuredTdError(err);
    }
    return result;
  }
}
