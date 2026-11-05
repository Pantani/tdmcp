import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import type { z } from "zod";
import { type Logger, silentLogger } from "../utils/logger.js";
import { AceApiError, AceConnectionError, AceTimeoutError } from "./types.js";
import {
  type AceGenerateRequest,
  AceHealthSchema,
  type JobStatus,
  QueryResultSchema,
  ReleaseTaskSchema,
  type ResultItem,
  ResultItemSchema,
} from "./validators.js";

export interface AceStepClientOptions {
  baseUrl: string;
  /** Per-request timeout, and the deadline of a blocking generation. Default 10 min. */
  timeoutMs?: number;
  logger?: Logger;
  /** Optional API key (`ACESTEP_API_KEY` upstream); sent as `Authorization: Bearer <token>`. */
  token?: string;
  /** Overridable for tests (defaults to global `fetch`). */
  fetchImpl?: typeof fetch;
  /** `inference_steps` sent when the caller omits it, and the `rtf` baseline. */
  defaultSteps?: number;
  /** Directory the finished audio is downloaded into. Resolved to an absolute path. */
  outputDir?: string;
  /** `TDMCP_ACE_SYNC_MAX_SECONDS` — estimates above this go async in `mode:"auto"`. */
  syncMaxSeconds?: number;
  /**
   * `TDMCP_ACE_RTF` — wall-clock seconds of compute per second of audio, at
   * `defaultSteps`. Hardware-dependent, so there is deliberately NO default: unset
   * means no estimate, which means `mode:"auto"` stays sync.
   */
  rtf?: number;
  /** `TDMCP_ACE_POLL_MS` — job-poll + progress cadence. */
  pollMs?: number;
}

/** Upstream's turbo-model default. Base models want 32-64: set `TDMCP_ACE_DEFAULT_STEPS`. */
const DEFAULT_STEPS = 8;
const DEFAULT_OUTPUT_DIR = ".tdmcp/ace-output";
const DEFAULT_TIMEOUT_MS = 600000;
const DEFAULT_SYNC_MAX_SECONDS = 120;
const DEFAULT_POLL_MS = 2000;
const AUDIO_ROUTE = "/v1/audio";
const AUDIO_EXTENSIONS = new Set([".wav", ".flac", ".mp3", ".ogg", ".opus", ".aac"]);
const MAX_ERROR_DETAIL_CHARS = 500;

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** FastAPI errors carry `detail`; the unified envelope carries `error`. */
function extractErrorMessage(json: unknown): string | undefined {
  if (!json || typeof json !== "object") return undefined;
  const obj = json as Record<string, unknown>;
  return stringField(obj.error) ?? stringField(obj.detail);
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

function decodeResultArray(raw: unknown): unknown[] | undefined {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Upstream double-encodes `result`, and may leave it as raw text on failure. */
function firstResultItem(raw: unknown): ResultItem | undefined {
  const parsed = ResultItemSchema.safeParse(decodeResultArray(raw)?.[0]);
  return parsed.success ? parsed.data : undefined;
}

/** `seed_value` is comma-separated (one per batch item); we always request one. */
function parseSeed(value: ResultItem["seed_value"]): number | undefined {
  if (value == null) return undefined;
  const seed = Number(String(value).split(",")[0]);
  return Number.isInteger(seed) ? seed : undefined;
}

function positive(value: number | null | undefined): number | undefined {
  return value != null && value > 0 ? value : undefined;
}

function failureMessage(raw: unknown, item: ResultItem | undefined): string {
  if (item?.error) return item.error;
  // A failed row can hold raw text instead of JSON.
  const unparsed = typeof raw === "string" && !decodeResultArray(raw) ? raw : undefined;
  return unparsed?.slice(0, MAX_ERROR_DETAIL_CHARS) || "ACE-Step reported the job as failed.";
}

/**
 * HTTP client for the ACE-Step 1.5 REST server. Mirrors `TouchDesignerClient`: one
 * private `request<T>()` with an AbortController timeout, and every failure surfaces
 * as a typed `AceError` so tool handlers turn them into friendly messages.
 */
export class AceStepClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly logger: Logger;
  private readonly token: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly defaultSteps: number;
  private readonly outputDir: string;
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
    this.outputDir = resolve(options.outputDir ?? DEFAULT_OUTPUT_DIR);
    this.syncMax = options.syncMaxSeconds ?? DEFAULT_SYNC_MAX_SECONDS;
    this.realTimeFactor = options.rtf;
    this.pollIntervalMs = options.pollMs ?? DEFAULT_POLL_MS;
  }

  get endpoint(): string {
    return this.baseUrl;
  }

  /** Steps sent when the caller omits `inference_steps` (the RTF baseline). */
  get steps(): number {
    return this.defaultSteps;
  }

  /** An estimate above this hands off to a job in `mode:"auto"`. */
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

  /** Deadline of a blocking generation, in ms. */
  get generationTimeoutMs(): number {
    return this.timeoutMs;
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
      `Cannot reach the ACE-Step API server at ${this.baseUrl}. Start it from your ACE-Step 1.5 checkout (uv run acestep-api, or start_api_server_macos.sh on Apple Silicon).`,
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

  private async request<T>(
    method: string,
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
  ): Promise<T> {
    const response = await this.doFetch(method, path, body);
    const json = await parseJsonBody(response);
    const failure = extractErrorMessage(json);
    if (!response.ok || failure) {
      throw new AceApiError(
        failure ?? `ACE-Step returned HTTP ${response.status} for ${method} ${path}.`,
        { status: response.status },
      );
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new AceApiError(
        `Unexpected data shape from ACE-Step for ${method} ${path}: ${parsed.error.message}`,
        { status: response.status },
      );
    }
    return parsed.data;
  }

  /**
   * The `/release_task` body. `batch_size` defaults to 2 upstream, and `audio_format`
   * to mp3, which is why both are pinned: one bed, in a format TD reads losslessly.
   * Optional fields are left out so upstream's own defaults apply.
   */
  private buildReleaseBody(req: AceGenerateRequest): Record<string, unknown> {
    return {
      prompt: req.prompt,
      ...(req.lyrics !== undefined ? { lyrics: req.lyrics } : {}),
      ...(req.audio_duration !== undefined ? { audio_duration: req.audio_duration } : {}),
      inference_steps: req.inference_steps ?? this.defaultSteps,
      ...(req.guidance_scale !== undefined ? { guidance_scale: req.guidance_scale } : {}),
      ...(req.seed !== undefined ? { use_random_seed: false, seed: req.seed } : {}),
      batch_size: 1,
      audio_format: "wav",
    };
  }

  /** `POST /release_task` — queues a generation and returns its id. */
  async submitGenerate(req: AceGenerateRequest): Promise<{ job_id: string }> {
    const { data } = await this.request(
      "POST",
      "/release_task",
      ReleaseTaskSchema,
      this.buildReleaseBody(req),
    );
    return { job_id: data.task_id };
  }

  /**
   * `POST /query_result` for one id. On success this also downloads the audio
   * (once), so `wavPath` is always a real local file that TD can open.
   */
  async getJob(jobId: string): Promise<JobStatus> {
    const { data } = await this.request("POST", "/query_result", QueryResultSchema, {
      task_id_list: [jobId],
    });
    const row = data[0];
    if (!row) throw new AceApiError(`ACE-Step returned no row for job ${jobId}.`);
    const item = firstResultItem(row.result);

    if (row.status === 2) return { status: "error", error: failureMessage(row.result, item) };
    if (row.status === 1) return this.finishedJob(jobId, item);
    // Upstream answers an unknown id with status 0 and an empty list, forever.
    if (!item) {
      throw new AceApiError(
        `ACE-Step does not know job ${jobId} (wrong id, or the server restarted and lost it).`,
      );
    }
    return {
      status: "running",
      ...(item.progress != null ? { progress: item.progress } : {}),
      ...(item.stage ? { stage: item.stage } : {}),
    };
  }

  private async finishedJob(jobId: string, item: ResultItem | undefined): Promise<JobStatus> {
    if (!item?.file) throw new AceApiError(`ACE-Step job ${jobId} finished without an audio file.`);
    const wavPath = await this.downloadAudio(jobId, item.file);
    const seconds = positive(item.metas?.duration);
    const seed = parseSeed(item.seed_value);
    return {
      status: "done",
      wavPath,
      ...(seconds !== undefined ? { seconds } : {}),
      ...(seed !== undefined ? { seed } : {}),
    };
  }

  /**
   * The file URL comes from the server, so it is held to this server's audio route:
   * following anything else could send the API key to another host.
   */
  private audioUrl(file: string): URL {
    const url = new URL(file, `${this.baseUrl}/`);
    if (url.origin !== new URL(this.baseUrl).origin || url.pathname !== AUDIO_ROUTE) {
      throw new AceApiError(`ACE-Step returned an unexpected audio URL: ${file}`);
    }
    return url;
  }

  private destinationFor(jobId: string, url: URL): string {
    const ext = extname(url.searchParams.get("path") ?? "").toLowerCase();
    const safeId = jobId.replace(/[^A-Za-z0-9_-]/g, "_");
    return resolve(this.outputDir, `${safeId}${AUDIO_EXTENSIONS.has(ext) ? ext : ".wav"}`);
  }

  /** Idempotent: polling a finished job again reuses the file already on disk. */
  private async downloadAudio(jobId: string, file: string): Promise<string> {
    const url = this.audioUrl(file);
    const dest = this.destinationFor(jobId, url);
    const existing = await stat(dest).catch(() => undefined);
    if (existing && existing.size > 0) return dest;

    const bytes = await this.fetchAudioBytes(url);
    await mkdir(this.outputDir, { recursive: true });
    // Written beside the target and renamed, so TD can never open a partial file.
    const temp = `${dest}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, bytes);
      await rename(temp, dest);
    } catch (err) {
      await rm(temp, { force: true });
      throw err;
    }
    return dest;
  }

  private async fetchAudioBytes(url: URL): Promise<Uint8Array> {
    const path = url.pathname;
    const controller = new AbortController();
    // Held across the body read: a large WAV is slow to arrive after the headers.
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        signal: controller.signal,
        headers: this.buildHeaders(undefined),
      });
      if (!response.ok) {
        throw new AceApiError(`ACE-Step returned HTTP ${response.status} for GET ${path}.`, {
          status: response.status,
        });
      }
      return new Uint8Array(await response.arrayBuffer());
    } catch (err) {
      if (err instanceof AceApiError) throw err;
      throw this.toTransportError(err, "GET", path);
    } finally {
      clearTimeout(timer);
    }
  }

  /** `GET /health`. */
  async health() {
    const { data } = await this.request("GET", "/health", AceHealthSchema);
    return data;
  }
}
