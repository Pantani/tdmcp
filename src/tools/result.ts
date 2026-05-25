import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { friendlyTdError } from "../td-client/types.js";

type Content = CallToolResult["content"];

export function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

export function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

/** A text block followed by a pretty-printed JSON code fence. */
export function jsonResult(summary: string, data: unknown): CallToolResult {
  const text = `${summary}\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;
  return { content: [{ type: "text", text }] };
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
