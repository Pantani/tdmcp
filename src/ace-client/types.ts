import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { errorResult } from "../tools/result.js";

/** Base error for all ACE-Step wrapper failures (twin of `TdError`). */
export class AceError extends Error {
  readonly code: string;

  constructor(message: string, code: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AceError";
    this.code = code;
  }
}

/** The ACE-Step wrapper could not be reached (server not running, wrong host/port). */
export class AceConnectionError extends AceError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, "ACE_CONNECTION", options);
    this.name = "AceConnectionError";
  }
}

/** The request exceeded the configured timeout (AbortController fired). */
export class AceTimeoutError extends AceError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, "ACE_TIMEOUT", options);
    this.name = "AceTimeoutError";
  }
}

/** The wrapper responded but reported an error (HTTP non-2xx or `ok: false`). */
export class AceApiError extends AceError {
  readonly status: number | undefined;

  constructor(message: string, options?: { status?: number; cause?: unknown }) {
    super(message, "ACE_API", options);
    this.name = "AceApiError";
    this.status = options?.status;
  }
}

/** Produces a human-friendly, single-line description of any ACE error. */
export function friendlyAceError(err: unknown): string {
  if (err instanceof AceError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Runs an ACE-Step client call and formats the result, converting any ACE error
 * into a friendly `isError` result instead of throwing out of the MCP handler.
 *
 * Twin of `guardTd` in `src/tools/result.ts`, kept here so this feature's tool
 * compiles green in isolation without a shared-file edit — the integrator may
 * promote it into `result.ts` next to `guardTd` if desired.
 */
export async function guardAce<T>(
  fn: () => Promise<T>,
  onOk: (value: T) => CallToolResult,
): Promise<CallToolResult> {
  try {
    return onOk(await fn());
  } catch (err) {
    return errorResult(friendlyAceError(err));
  }
}
