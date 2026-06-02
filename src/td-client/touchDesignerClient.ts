import type { z } from "zod";
import { type Logger, silentLogger } from "../utils/logger.js";
import { TdApiError, TdConnectionError, TdTimeoutError } from "./types.js";
import {
  ApiEnvelopeSchema,
  BatchResultSchema,
  BridgeLogsSchema,
  ConnectResultSchema,
  type CreateNodeInput,
  CreateNodeInputSchema,
  DatTextSchema,
  DatTextWriteSchema,
  DeleteResultSchema,
  DisconnectResultSchema,
  ExecResultSchema,
  InfoSchema,
  MethodResultSchema,
  NodeDetailSchema,
  NodeErrorsSchema,
  NodeListSchema,
  NodeRefSchema,
  ParamModesSchema,
  PerformanceSchema,
  PreviewSchema,
  ProjectAnalysisSchema,
  SetParamModeResultSchema,
  SystemInfoSchema,
  type TdBatchOperation,
  type TdProjectAnalysis,
  type TdSystemInfo,
  TopologySchema,
  TransportStateSchema,
} from "./validators.js";

export interface TouchDesignerClientOptions {
  baseUrl: string;
  timeoutMs?: number;
  logger?: Logger;
  /** Optional shared bearer token; sent as `Authorization: Bearer <token>` when set. */
  token?: string;
  /** Overridable for tests (defaults to global `fetch`). */
  fetchImpl?: typeof fetch;
  /**
   * Extra attempts for a transient connection failure on an **idempotent** (GET)
   * request — e.g. TD briefly stalls mid-build. Default 2 (so up to 3 tries).
   * Only `TdConnectionError` is retried; timeouts and bridge errors are not (a
   * timeout may mean the request was received, and non-GET methods aren't safe
   * to repeat). Set 0 to disable.
   */
  retries?: number;
  /** Base backoff between retries, in ms (linear: delay × attempt). Default 150. */
  retryDelayMs?: number;
}

type QueryParams = Record<string, string | number | boolean | undefined>;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function extractErrorMessage(json: unknown): string | undefined {
  if (json && typeof json === "object") {
    const obj = json as Record<string, unknown>;
    const error = obj.error;
    if (
      error &&
      typeof error === "object" &&
      typeof (error as Record<string, unknown>).message === "string"
    ) {
      return (error as Record<string, string>).message;
    }
    if (typeof obj.message === "string") return obj.message;
  }
  return undefined;
}

/** Encodes a TD node path (which contains slashes) into a single URL segment. */
function segment(path: string): string {
  return encodeURIComponent(path);
}

/**
 * HTTP client for the TouchDesigner REST bridge. Every method maps to one of the
 * endpoints in the bridge spec. All failures surface as typed `TdError`s so MCP
 * tool handlers can convert them into friendly messages without crashing.
 */
export class TouchDesignerClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly logger: Logger;
  private readonly token: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly retries: number;
  private readonly retryDelayMs: number;

  constructor(options: TouchDesignerClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 10000;
    this.logger = options.logger ?? silentLogger;
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.retries = Math.max(0, options.retries ?? 2);
    this.retryDelayMs = Math.max(0, options.retryDelayMs ?? 150);
  }

  get endpoint(): string {
    return this.baseUrl;
  }

  private async request<T>(
    method: string,
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
    query?: QueryParams,
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }

    // Retry a transient connection failure only for idempotent GETs — a TD that
    // briefly stalls mid-build shouldn't abort the whole operation. Timeouts and
    // bridge/API errors are never retried (a timeout may mean the request was
    // received; non-GET methods aren't safe to repeat).
    const maxAttempts = method === "GET" ? this.retries + 1 : 1;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.attemptRequest(method, url, path, schema, body);
      } catch (err) {
        lastError = err;
        const retriableConnection = err instanceof TdConnectionError;
        const retriable5xx =
          err instanceof TdApiError && typeof err.status === "number" && err.status >= 500;
        if ((retriableConnection || retriable5xx) && attempt < maxAttempts) {
          this.logger.debug(
            `TD ${method} ${path} ${retriable5xx ? `failed ${err.status}` : "connection failed"} ` +
              `(attempt ${attempt}/${maxAttempts}); retrying`,
          );
          await sleep(this.retryDelayMs * attempt);
          continue;
        }
        throw err;
      }
    }
    throw lastError;
  }

  private async attemptRequest<T>(
    method: string,
    url: URL,
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      this.logger.debug(`TD ${method} ${path}`);
      const headers: Record<string, string> = {};
      if (body !== undefined) headers["content-type"] = "application/json";
      if (this.token) headers.authorization = `Bearer ${this.token}`;
      response = await this.fetchImpl(url, {
        method,
        signal: controller.signal,
        headers: Object.keys(headers).length > 0 ? headers : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new TdTimeoutError(
          `TouchDesigner request timed out after ${this.timeoutMs}ms (${method} ${path}).`,
          { cause: err },
        );
      }
      throw new TdConnectionError(
        `Cannot reach TouchDesigner at ${this.baseUrl}. Make sure TD is running with the tdmcp bridge (WebServer DAT) installed and listening on that port.`,
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
      const message =
        extractErrorMessage(json) ??
        `TouchDesigner bridge returned HTTP ${response.status} for ${method} ${path}.`;
      throw new TdApiError(message, { status: response.status });
    }

    const envelope = ApiEnvelopeSchema.safeParse(json);
    if (!envelope.success) {
      throw new TdApiError(`Malformed response from TouchDesigner bridge for ${method} ${path}.`, {
        status: response.status,
      });
    }
    if (!envelope.data.ok) {
      throw new TdApiError(
        envelope.data.error?.message ?? `TouchDesigner reported an error for ${method} ${path}.`,
        { status: response.status, apiCode: envelope.data.error?.code },
      );
    }

    const parsed = schema.safeParse(envelope.data.data);
    if (!parsed.success) {
      throw new TdApiError(
        `Unexpected data shape from TouchDesigner bridge for ${method} ${path}: ${parsed.error.message}`,
        { status: response.status },
      );
    }
    return parsed.data;
  }

  getInfo() {
    return this.request("GET", "/api/info", InfoSchema);
  }

  createNode(input: CreateNodeInput) {
    return this.request("POST", "/api/nodes", NodeRefSchema, CreateNodeInputSchema.parse(input));
  }

  deleteNode(path: string) {
    return this.request("DELETE", `/api/nodes/${segment(path)}`, DeleteResultSchema);
  }

  getNodes(parentPath?: string) {
    return this.request("GET", "/api/nodes", NodeListSchema, undefined, { parent: parentPath });
  }

  getNode(path: string) {
    return this.request("GET", `/api/nodes/${segment(path)}`, NodeDetailSchema);
  }

  updateNodeParameters(path: string, parameters: Record<string, unknown>) {
    return this.request("PATCH", `/api/nodes/${segment(path)}`, NodeDetailSchema, { parameters });
  }

  executePythonScript(script: string, returnOutput = true) {
    return this.request("POST", "/api/exec", ExecResultSchema, {
      script,
      return_output: returnOutput,
    });
  }

  execNodeMethod(
    path: string,
    method: string,
    args: unknown[] = [],
    kwargs: Record<string, unknown> = {},
  ) {
    return this.request("POST", `/api/nodes/${segment(path)}/method`, MethodResultSchema, {
      method,
      args,
      kwargs,
    });
  }

  getNodeErrors(path: string) {
    return this.request("GET", `/api/nodes/${segment(path)}/errors`, NodeErrorsSchema);
  }

  getPreview(path: string, width = 640, height = 360) {
    return this.request("GET", `/api/preview/${segment(path)}`, PreviewSchema, undefined, {
      width,
      height,
    });
  }

  batch(operations: TdBatchOperation[]) {
    return this.request("POST", "/api/batch", BatchResultSchema, { operations });
  }

  getNetworkErrors(path: string) {
    return this.request("GET", `/api/network/${segment(path)}/errors`, NodeErrorsSchema);
  }

  getNetworkTopology(path: string, recursive = false) {
    return this.request(
      "GET",
      `/api/network/${segment(path)}/topology`,
      TopologySchema,
      undefined,
      recursive ? { recursive: true } : undefined,
    );
  }

  getNetworkPerformance(path: string, recursive = false) {
    return this.request(
      "GET",
      `/api/network/${segment(path)}/performance`,
      PerformanceSchema,
      undefined,
      recursive ? { recursive: true } : undefined,
    );
  }

  // --- First-class wiring (survives TDMCP_BRIDGE_ALLOW_EXEC=0) ---
  connectNodes(sourcePath: string, targetPath: string, sourceOutput = 0, targetInput = 0) {
    return this.request("POST", "/api/connect", ConnectResultSchema, {
      source_path: sourcePath,
      target_path: targetPath,
      source_output: sourceOutput,
      target_input: targetInput,
    });
  }

  disconnectNodes(toPath: string, fromPath?: string, toInput?: number) {
    return this.request("POST", "/api/disconnect", DisconnectResultSchema, {
      to_path: toPath,
      from_path: fromPath ?? null,
      to_input: toInput ?? null,
    });
  }

  // --- Param-mode + DAT-text endpoints (survive ALLOW_EXEC=0) ---
  readParameterModes(path: string, keys?: string[], nonDefaultOnly = false) {
    return this.request("GET", `/api/nodes/${segment(path)}/params`, ParamModesSchema, undefined, {
      modes: true,
      keys: keys?.join(","),
      non_default_only: nonDefaultOnly || undefined,
    });
  }

  setParameterMode(path: string, param: string, mode: string, expr?: string, value?: unknown) {
    return this.request(
      "PATCH",
      `/api/nodes/${segment(path)}/params/${encodeURIComponent(param)}/mode`,
      SetParamModeResultSchema,
      { mode, expr, value },
    );
  }

  getDatText(path: string) {
    return this.request("GET", `/api/nodes/${segment(path)}/text`, DatTextSchema);
  }

  putDatText(path: string, text: string) {
    return this.request("PUT", `/api/nodes/${segment(path)}/text`, DatTextWriteSchema, { text });
  }

  // --- Timeline transport (survives ALLOW_EXEC=0) ---
  controlTimelineTransport(payload: {
    action: "play" | "pause" | "seek" | "cue" | "rate";
    frame?: number;
    rate?: number;
    cueName?: string;
  }) {
    return this.request("POST", "/api/transport", TransportStateSchema, payload);
  }

  // --- System info (GPU + monitors + perform mode) — survives ALLOW_EXEC=0 ---
  getSystemInfo(include?: Array<"gpu" | "monitors" | "performMode">): Promise<TdSystemInfo> {
    return this.request("GET", "/api/system", SystemInfoSchema, undefined, {
      include: include?.length ? include.join(",") : undefined,
    });
  }

  // --- Project diagnostic scan (survives ALLOW_EXEC=0) ---
  analyzeProject(path: string, recursive = true): Promise<TdProjectAnalysis> {
    return this.request(
      "GET",
      `/api/projects/${segment(path)}/analysis`,
      ProjectAnalysisSchema,
      undefined,
      { recursive: recursive ? "true" : "false" },
    );
  }

  // --- Structured bridge logs (Error DAT reader) ---
  getLogs(severity = "all", maxLines = 200, scope?: string) {
    return this.request("GET", "/api/logs", BridgeLogsSchema, undefined, {
      severity,
      max_lines: maxLines,
      scope,
    });
  }
}
