/** Base error for all TouchDesigner bridge failures. */
export class TdError extends Error {
  readonly code: string;

  constructor(message: string, code: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TdError";
    this.code = code;
  }
}

/** The bridge could not be reached (TD not running, wrong host/port, etc.). */
export class TdConnectionError extends TdError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, "TD_CONNECTION", options);
    this.name = "TdConnectionError";
  }
}

/** The request exceeded the configured timeout. */
export class TdTimeoutError extends TdError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, "TD_TIMEOUT", options);
    this.name = "TdTimeoutError";
  }
}

/** The bridge responded but reported an error (HTTP non-2xx or `ok: false`). */
export class TdApiError extends TdError {
  readonly status: number | undefined;
  readonly apiCode: string | undefined;
  /** Route-specific, schema-validated failure evidence (never arbitrary bridge data). */
  readonly details: unknown;

  constructor(
    message: string,
    options?: { status?: number; apiCode?: string; details?: unknown; cause?: unknown },
  ) {
    super(message, "TD_API", options);
    this.name = "TdApiError";
    this.status = options?.status;
    this.apiCode = options?.apiCode;
    this.details = options?.details;
  }
}

/**
 * The bridge is shedding load (HTTP 503) after a slow request so TouchDesigner's
 * cook loop can recover. Retryable: wait `retryAfterMs` and try again.
 */
export class TdBackpressureError extends TdError {
  readonly retryAfterMs: number;
  readonly retryable = true;

  constructor(message: string, options: { retryAfterMs: number; cause?: unknown }) {
    super(message, "TD_BACKPRESSURE", options);
    this.name = "TdBackpressureError";
    this.retryAfterMs = options.retryAfterMs;
  }
}

/** Produces a human-friendly, single-line description of any error. */
export function friendlyTdError(err: unknown): string {
  if (err instanceof TdApiError && err.apiCode) {
    return `[${err.apiCode}] ${err.message}`;
  }
  if (err instanceof TdError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * True when a {@link TdApiError} means the REST route is ABSENT on the bridge —
 * an older bridge that predates this endpoint — as opposed to a *validation*
 * rejection from a current bridge. Both an unmatched route and a validation
 * failure come back as HTTP 400 (the bridge's router raises
 * `ValueError("Unsupported <METHOD> <path>")` for an unknown route, and 400 for
 * a bad request); some setups/proxies answer 404. Only the missing-route case
 * may fall back to the exec path — a real validation 400 (e.g. "cannot wire
 * across containers", "No such parameter", "is not a DAT") must surface so
 * `TDMCP_BRIDGE_ALLOW_EXEC=0` users see the reason and exec-enabled users don't
 * silently run a second implementation after the endpoint already rejected.
 */
export function isMissingEndpoint(err: unknown): boolean {
  if (!(err instanceof TdApiError)) return false;
  if (err.status === 404) return true;
  return /^Unsupported (GET|POST|PUT|PATCH|DELETE) /.test(err.message);
}

/**
 * Canonical "prefer first-class REST endpoint, fall back to the exec path only
 * when the endpoint is absent" wrapper.
 *
 * Tries `endpoint()` first; if it throws and the error is a missing-endpoint
 * signal (older bridge, route not yet shipped), the result of `fallback()` is
 * returned instead. **Any other error** — a current bridge's validation 400, a
 * connection failure, a timeout — is rethrown unchanged so callers (and
 * `TDMCP_BRIDGE_ALLOW_EXEC=0` setups) see the real reason instead of silently
 * re-running a second implementation.
 *
 * This replaces the explicit
 * ```
 * try { return await endpoint(); }
 * catch (err) { if (!isMissingEndpoint(err)) throw err; }
 * return fallback();
 * ```
 * pattern that recurs across layer-3 tools that promoted off exec.
 */
export async function tryEndpoint<T>(
  endpoint: () => Promise<T>,
  fallback: () => Promise<T>,
): Promise<T> {
  try {
    return await endpoint();
  } catch (err) {
    if (!isMissingEndpoint(err)) throw err;
    return fallback();
  }
}

export type {
  ApiEnvelope,
  CreateNodeInput,
  TdBatchOperation,
  TdBatchResult,
  TdBoundedSearchMetadata,
  TdConnection,
  TdDeleteResult,
  TdExecResult,
  TdInfo,
  TdMethodResult,
  TdNodeDetail,
  TdNodeError,
  TdNodeErrors,
  TdNodeList,
  TdNodeRef,
  TdNodeSearchHit,
  TdNodeSearchResult,
  TdOperatorFamily,
  TdParameterSearchHit,
  TdParameterSearchMode,
  TdParameterSearchResult,
  TdPerformance,
  TdPreview,
  TdTopology,
} from "./validators.js";
