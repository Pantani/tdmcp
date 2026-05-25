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

  constructor(message: string, options?: { status?: number; apiCode?: string; cause?: unknown }) {
    super(message, "TD_API", options);
    this.name = "TdApiError";
    this.status = options?.status;
    this.apiCode = options?.apiCode;
  }
}

export function isTdError(err: unknown): err is TdError {
  return err instanceof TdError;
}

/** Produces a human-friendly, single-line description of any error. */
export function friendlyTdError(err: unknown): string {
  if (err instanceof TdError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

export type {
  ApiEnvelope,
  CreateNodeInput,
  TdBatchOperation,
  TdBatchResult,
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
  TdPerformance,
  TdPreview,
  TdTopology,
} from "./validators.js";
