/**
 * Creative RAG — typed Ollama errors.
 *
 * Mirrors `src/td-client/types.ts`: a base {@link OllamaError} carrying a stable
 * `code`, plus connection/timeout/api subclasses and a friendly one-liner. Every
 * networked Ollama call surfaces failures as one of these so callers (the CLI,
 * the service facade) can react without inspecting raw fetch errors.
 */

/** Base error for all Ollama embeddings failures. */
export class OllamaError extends Error {
  readonly code: string;

  constructor(message: string, code: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "OllamaError";
    this.code = code;
  }
}

/** Ollama could not be reached (not running, wrong host/port, etc.). */
export class OllamaConnectionError extends OllamaError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, "OLLAMA_CONNECTION", options);
    this.name = "OllamaConnectionError";
  }
}

/** The request exceeded the configured timeout. */
export class OllamaTimeoutError extends OllamaError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, "OLLAMA_TIMEOUT", options);
    this.name = "OllamaTimeoutError";
  }
}

/** Ollama responded but reported an error (HTTP non-2xx or a malformed body). */
export class OllamaApiError extends OllamaError {
  readonly status: number | undefined;

  constructor(message: string, options?: { status?: number; cause?: unknown }) {
    super(message, "OLLAMA_API", options);
    this.name = "OllamaApiError";
    this.status = options?.status;
  }
}

/** Produces a human-friendly, single-line description of any error. */
export function friendlyOllamaError(err: unknown): string {
  if (err instanceof OllamaError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
