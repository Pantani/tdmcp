import type { z } from "zod";
import { type Logger, silentLogger } from "../utils/logger.js";
import { AceApiError, AceConnectionError, AceTimeoutError } from "./types.js";
import {
  type AceGenerateRequest,
  AceHealthSchema,
  GenerateResultSchema,
  JobCancelSchema,
  JobStatusSchema,
  JobSubmitSchema,
  NativeGenerateResultSchema,
} from "./validators.js";

export interface AceStepClientOptions {
  baseUrl: string;
  /** Generation is slow; default 10 min (far larger than the TD bridge's 10 s). */
  timeoutMs?: number;
  logger?: Logger;
  /** Optional bearer token; sent as `Authorization: Bearer <token>` when set. */
  token?: string;
  /** Overridable for tests (defaults to global `fetch`). */
  fetchImpl?: typeof fetch;
  /** tdmcp default diffusion steps injected when the caller omits `infer_step`. */
  defaultSteps?: number;
  /** Directory passed as the wrapper's `save_path` when the caller omits it. */
  outputDir?: string;
  /** Serving mode. "wrapper" (default) → local ace/ FastAPI; "native" → ACE's infer-api.py :8000. */
  mode?: "wrapper" | "native";
  /** `TDMCP_ACE_SYNC_MAX_SECONDS` — F6: estimates above this go async in `mode:"auto"`. */
  syncMaxSeconds?: number;
  /**
   * `TDMCP_ACE_RTF` — wall-clock seconds of compute per second of audio, at
   * `defaultSteps`. UNMEASURED, so there is deliberately NO default: unset means
   * no estimate, which means `mode:"auto"` stays sync (F6 inert).
   */
  rtf?: number;
  /** `TDMCP_ACE_POLL_MS` — job-poll + progress cadence. */
  pollMs?: number;
}

/** ACE upstream default; `defaultSteps` (27) is the tdmcp faster default. */
const DEFAULT_GUIDANCE_SCALE = 15.0;
const DEFAULT_STEPS = 27;
const DEFAULT_OUTPUT_DIR = ".tdmcp/ace-output";
const DEFAULT_TIMEOUT_MS = 600000;
const DEFAULT_SYNC_MAX_SECONDS = 120;
const DEFAULT_POLL_MS = 2000;

function extractErrorMessage(json: unknown): string | undefined {
  if (json && typeof json === "object") {
    const obj = json as Record<string, unknown>;
    if (typeof obj.error === "string") return obj.error;
    if (obj.error && typeof obj.error === "object") {
      const inner = (obj.error as Record<string, unknown>).message;
      if (typeof inner === "string") return inner;
    }
    if (typeof obj.message === "string") return obj.message;
  }
  return undefined;
}

/**
 * HTTP client for the local ACE-Step FastAPI wrapper. Mirrors
 * `TouchDesignerClient`: one private `request<T>()` with an AbortController
 * timeout, and every failure surfaces as a typed `AceError` so MCP tool
 * handlers convert them into friendly messages without crashing.
 */
export class AceStepClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly logger: Logger;
  private readonly token: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly defaultSteps: number;
  private readonly outputDir: string;
  private readonly serveMode: "wrapper" | "native";
  private readonly syncMax: number;
  private readonly realTimeFactor: number | undefined;
  private readonly pollIntervalMs: number;

  constructor(options: AceStepClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.logger = options.logger ?? silentLogger;
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.defaultSteps = options.defaultSteps ?? DEFAULT_STEPS;
    this.outputDir = options.outputDir ?? DEFAULT_OUTPUT_DIR;
    this.serveMode = options.mode ?? "wrapper";
    this.syncMax = options.syncMaxSeconds ?? DEFAULT_SYNC_MAX_SECONDS;
    this.realTimeFactor = options.rtf;
    this.pollIntervalMs = options.pollMs ?? DEFAULT_POLL_MS;
  }

  get endpoint(): string {
    return this.baseUrl;
  }

  get mode(): "wrapper" | "native" {
    return this.serveMode;
  }

  /** Diffusion steps injected when the caller omits `infer_step` (RTF baseline). */
  get steps(): number {
    return this.defaultSteps;
  }

  /** F6 threshold: an estimate above this hands off to a job in `mode:"auto"`. */
  get syncMaxSeconds(): number {
    return this.syncMax;
  }

  /** Operator-calibrated RTF; `undefined` = uncalibrated (no estimate, auto stays sync). */
  get rtf(): number | undefined {
    return this.realTimeFactor;
  }

  /** Job-poll + progress cadence, in ms. */
  get pollMs(): number {
    return this.pollIntervalMs;
  }

  private async request<T>(
    method: string,
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      this.logger.debug(`ACE ${method} ${path}`);
      const headers: Record<string, string> = {};
      if (body !== undefined) headers["content-type"] = "application/json";
      if (this.token) headers.authorization = `Bearer ${this.token}`;
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        signal: controller.signal,
        headers: Object.keys(headers).length > 0 ? headers : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new AceTimeoutError(
          `ACE-Step request timed out after ${this.timeoutMs}ms (${method} ${path}).`,
          { cause: err },
        );
      }
      throw new AceConnectionError(
        `Cannot reach the ACE-Step wrapper at ${this.baseUrl}. Make sure the ace/ FastAPI server is running (python -m ace.wrapper).`,
        { cause: err },
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let json: unknown;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }

    if (!response.ok) {
      throw new AceApiError(
        extractErrorMessage(json) ??
          `ACE-Step wrapper returned HTTP ${response.status} for ${method} ${path}.`,
        { status: response.status },
      );
    }
    if (json && typeof json === "object" && (json as Record<string, unknown>).ok === false) {
      throw new AceApiError(
        extractErrorMessage(json) ?? `ACE-Step wrapper reported an error for ${method} ${path}.`,
        { status: response.status },
      );
    }

    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new AceApiError(
        `Unexpected data shape from the ACE-Step wrapper for ${method} ${path}: ${parsed.error.message}`,
        { status: response.status },
      );
    }
    return parsed.data;
  }

  /**
   * The wrapper `POST /generate` / `POST /jobs` body — the tdmcp defaults
   * (`infer_step`, `guidance_scale`, `save_path`) are injected here so the sync
   * `generate()` fast path and the async `submitGenerate()` never drift.
   */
  private buildGenerateBody(req: AceGenerateRequest): Record<string, unknown> {
    return {
      prompt: req.prompt,
      lyrics: req.lyrics ?? null,
      audio_duration: req.audio_duration,
      manual_seeds: req.manual_seeds ?? null,
      infer_step: req.infer_step ?? this.defaultSteps,
      guidance_scale: req.guidance_scale ?? DEFAULT_GUIDANCE_SCALE,
      save_path: this.outputDir,
    };
  }

  private nativeUnsupported(): never {
    throw new AceApiError(
      "Job control is not supported in native ACE mode (infer-api.py is synchronous " +
        "and has no job API). Set TDMCP_ACE_MODE=wrapper.",
    );
  }

  /**
   * `POST /generate`. Signature/return type are the FROZEN P0 contract, unchanged
   * in either mode. In "wrapper" mode it posts the wrapper body; in "native" mode
   * it posts the `ACEStepInput` shape to `infer-api.py` and adapts `ACEStepOutput`
   * (which carries neither seconds nor seed) back to `GenerateResult`.
   */
  async generate(req: AceGenerateRequest) {
    if (this.serveMode === "native") {
      const body = {
        prompt: req.prompt,
        lyrics: req.lyrics ?? "",
        audio_duration: req.audio_duration,
        infer_step: req.infer_step ?? this.defaultSteps,
        guidance_scale: req.guidance_scale ?? DEFAULT_GUIDANCE_SCALE,
        actual_seeds: req.manual_seeds ?? null,
        output_path: this.outputDir,
      };
      const r = await this.request("POST", "/generate", NativeGenerateResultSchema, body);
      if (!r.output_path) {
        throw new AceApiError(r.message || "Native ACE server returned no output_path.");
      }
      return {
        wavPath: r.output_path,
        seconds: req.audio_duration > 0 ? req.audio_duration : 0,
        seed: req.manual_seeds ?? 0,
      };
    }
    return this.request("POST", "/generate", GenerateResultSchema, this.buildGenerateBody(req));
  }

  /** `POST /jobs` — non-blocking submit returning a `job_id` (wrapper mode only). */
  submitGenerate(req: AceGenerateRequest) {
    if (this.serveMode === "native") this.nativeUnsupported();
    return this.request("POST", "/jobs", JobSubmitSchema, this.buildGenerateBody(req));
  }

  /** `GET /jobs/{id}` — pollable job status (wrapper mode only). */
  getJob(jobId: string) {
    if (this.serveMode === "native") this.nativeUnsupported();
    return this.request("GET", `/jobs/${encodeURIComponent(jobId)}`, JobStatusSchema);
  }

  /** `POST /jobs/{id}/cancel` — SIGKILLs the worker to free VRAM (wrapper mode only). */
  cancelJob(jobId: string) {
    if (this.serveMode === "native") this.nativeUnsupported();
    return this.request("POST", `/jobs/${encodeURIComponent(jobId)}/cancel`, JobCancelSchema);
  }

  /** `GET /health` — reports whether the warm pipeline finished constructing. */
  health() {
    return this.request("GET", "/health", AceHealthSchema);
  }
}
