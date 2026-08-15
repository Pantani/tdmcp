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
  /**
   * `TDMCP_ACE_CHECKPOINT_PATH` — filesystem path to the ACE-Step checkpoint dir,
   * sent as the native `ACEStepInput.checkpoint_path` (which has NO upstream
   * default and is required). Only consulted in `mode:"native"`.
   */
  checkpointPath?: string;
}

/** ACE upstream default; `defaultSteps` (27) is the tdmcp faster default. */
const DEFAULT_GUIDANCE_SCALE = 15.0;
const DEFAULT_STEPS = 27;
const DEFAULT_OUTPUT_DIR = ".tdmcp/ace-output";
const DEFAULT_TIMEOUT_MS = 600000;
const DEFAULT_SYNC_MAX_SECONDS = 120;
const DEFAULT_POLL_MS = 2000;

/**
 * Native `ACEStepInput` sampler defaults, source-verified against
 * `acestep/pipeline_ace_step.py __call__` (main): scheduler_type="euler",
 * cfg_type="apg", omega_scale=10.0, guidance_interval=0.5,
 * guidance_interval_decay=0.0, min_guidance_scale=3.0, use_erg_*=True,
 * oss_steps=None (empty list on the wire → no forced steps). These fields have
 * NO default in `ACEStepInput`, so tdmcp must supply every one or the request 422s.
 */
const NATIVE_SAMPLER_DEFAULTS = {
  scheduler_type: "euler",
  cfg_type: "apg",
  omega_scale: 10.0,
  guidance_interval: 0.5,
  guidance_interval_decay: 0.0,
  min_guidance_scale: 3.0,
  use_erg_tag: true,
  use_erg_lyric: true,
  use_erg_diffusion: true,
  guidance_scale_text: 0.0,
  guidance_scale_lyric: 0.0,
} as const;

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function nestedErrorMessage(error: unknown): string | undefined {
  if (error && typeof error === "object") {
    return stringField((error as Record<string, unknown>).message);
  }
  return undefined;
}

function extractErrorMessage(json: unknown): string | undefined {
  if (!json || typeof json !== "object") return undefined;
  const obj = json as Record<string, unknown>;
  return stringField(obj.error) ?? nestedErrorMessage(obj.error) ?? stringField(obj.message);
}

/** True when the wrapper returned a `{ ok: false }` error envelope on a 2xx. */
function isErrorEnvelope(json: unknown): boolean {
  return (
    Boolean(json) && typeof json === "object" && (json as Record<string, unknown>).ok === false
  );
}

async function parseJsonBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
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
  private readonly checkpointPath: string;

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
    this.checkpointPath = options.checkpointPath ?? "";
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

  private buildHeaders(body: unknown): Record<string, string> | undefined {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    return Object.keys(headers).length > 0 ? headers : undefined;
  }

  private toTransportError(err: unknown, method: string, path: string): Error {
    if (err instanceof Error && err.name === "AbortError") {
      return new AceTimeoutError(
        `ACE-Step request timed out after ${this.timeoutMs}ms (${method} ${path}).`,
        { cause: err },
      );
    }
    return new AceConnectionError(
      `Cannot reach the ACE-Step wrapper at ${this.baseUrl}. Make sure the ace/ FastAPI server is running (python -m ace.wrapper).`,
      { cause: err },
    );
  }

  private async doFetch(method: string, path: string, body: unknown): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      this.logger.debug(`ACE ${method} ${path}`);
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        signal: controller.signal,
        headers: this.buildHeaders(body),
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw this.toTransportError(err, method, path);
    } finally {
      clearTimeout(timer);
    }
  }

  private assertOk(response: Response, json: unknown, method: string, path: string): void {
    if (!response.ok) {
      throw new AceApiError(
        extractErrorMessage(json) ??
          `ACE-Step wrapper returned HTTP ${response.status} for ${method} ${path}.`,
        { status: response.status },
      );
    }
    if (isErrorEnvelope(json)) {
      throw new AceApiError(
        extractErrorMessage(json) ?? `ACE-Step wrapper reported an error for ${method} ${path}.`,
        { status: response.status },
      );
    }
  }

  private async request<T>(
    method: string,
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
  ): Promise<T> {
    const response = await this.doFetch(method, path, body);
    const json = await parseJsonBody(response);
    this.assertOk(response, json, method, path);

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

  /**
   * The native `infer-api.py` `POST /generate` body — a COMPLETE `ACEStepInput`.
   * Every field below is required upstream (no default in the pydantic model), so
   * a partial body 422s. `actual_seeds` is a `List[int]`: `[seed]` when seeded, or
   * `[]` when unseeded — ACE's own "random" convention (empty → `set_seeds` draws
   * a random seed; source-verified against `pipeline_ace_step.py`). Sampler defaults
   * come from `ACEStepPipeline.__call__` (see `NATIVE_SAMPLER_DEFAULTS`).
   */
  private buildNativeBody(req: AceGenerateRequest): Record<string, unknown> {
    return {
      checkpoint_path: this.checkpointPath,
      audio_duration: req.audio_duration,
      prompt: req.prompt,
      lyrics: req.lyrics ?? "",
      infer_step: req.infer_step ?? this.defaultSteps,
      guidance_scale: req.guidance_scale ?? DEFAULT_GUIDANCE_SCALE,
      actual_seeds: req.manual_seeds != null ? [req.manual_seeds] : [],
      oss_steps: [],
      output_path: this.outputDir,
      ...NATIVE_SAMPLER_DEFAULTS,
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
      const r = await this.request(
        "POST",
        "/generate",
        NativeGenerateResultSchema,
        this.buildNativeBody(req),
      );
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
