import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { friendlyTdError } from "../td-client/types.js";

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
    return errorResult(friendlyTdError(err));
  }
}
