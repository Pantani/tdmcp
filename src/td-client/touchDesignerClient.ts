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
  CustomParamsSchema,
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
  ParamModesBatchSchema,
  ParamModesSchema,
  PerformanceSchema,
  PerformModeStateSchema,
  PreviewSchema,
  ProjectAnalysisSchema,
  ProjectLoadSchema,
  SetParamModeResultSchema,
  SystemInfoSchema,
  type TdBatchOperation,
  type TdCustomParams,
  type TdPerformModeState,
  type TdProjectAnalysis,
  type TdProjectLoad,
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

/** Recover the JSON report object printed by an `/api/exec` pass (last `{…}` line,
 * then widest `{…}` span). Kept local so the client never imports from `src/tools`. */
function parseStdoutJson(stdout: string | undefined): unknown {
  if (!stdout) throw new TdApiError("The TouchDesigner script returned no output.");
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    if (line.startsWith("{") && line.endsWith("}")) {
      try {
        return JSON.parse(line);
      } catch {
        // fall through to span heuristic
      }
    }
    break;
  }
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(stdout.slice(start, end + 1));
    } catch {
      // fall through
    }
  }
  throw new TdApiError(`Could not parse the TouchDesigner script result: ${stdout.slice(0, 200)}`);
}

/** Exec fallback for `loadProject` on older bridges (no `/api/project/load`).
 * Mirrors `project_load_service.load`: validates, `project.load`s, walks the
 * loaded tree, and prints the report as the final JSON line. */
const LOAD_PROJECT_EXEC_SCRIPT = `
import base64, json, os
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
_path = (_p.get("path") or "").strip()
if not _path or not os.path.isabs(_path) or os.path.splitext(_path)[1].lower() not in (".toe", ".tox") or not os.path.exists(_path):
    raise ValueError("Field 'path' must be an existing absolute .toe/.tox file: %r" % _path)
project.load(_path)
def _root():
    try:
        kids = [c for c in op("/").children if bool(getattr(c, "isCOMP", False))]
        if kids:
            return kids[0].path
    except Exception:
        pass
    return "/project1"
_rp = _root()
_root_op = op(_rp)
_nodes = list(_root_op.findChildren(maxDepth=9999)) if _root_op is not None else []
_errors = []
for _n in _nodes:
    try:
        _e = _n.errors(recurse=False)
    except Exception:
        continue
    if not _e:
        continue
    for _line in (_e.splitlines() if isinstance(_e, str) else [_e]):
        _t = (_line or "").strip() if isinstance(_line, str) else str(_line)
        if _t:
            _errors.append({"path": _n.path, "message": _t, "level": "error"})
print(json.dumps({"root_path": _rp, "node_count": len(_nodes), "errors": _errors}))
`;

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

  // --- Custom-parameter readout (survives ALLOW_EXEC=0) ---
  // Powers serialize_network + inspect_component without a defensive exec walk.
  getCustomParams(path: string): Promise<TdCustomParams> {
    return this.request("GET", `/api/nodes/${segment(path)}/custom_params`, CustomParamsSchema);
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

  /** Batched read_parameter_modes (POST /api/param_modes/batch).
   *
   * Promotes N round-trips of `readParameterModes` to one. Older bridges that
   * don't ship the batch route answer 404/Unsupported — the caller should wrap
   * this in `tryEndpoint(...)` with a fallback that loops the singular method.
   * `readParameterModesBatchWithFallback` does exactly that for convenience.
   */
  readParameterModesBatch(
    items: Array<{ path: string; keys?: string[]; nonDefaultOnly?: boolean }>,
    continueOnError = true,
  ) {
    return this.request("POST", "/api/param_modes/batch", ParamModesBatchSchema, {
      items: items.map((i) => ({
        path: i.path,
        keys: i.keys ?? null,
        non_default_only: i.nonDefaultOnly ?? false,
      })),
      continue_on_error: continueOnError,
    });
  }

  /** Convenience: try the batch endpoint, fall back to N singular calls on 404
   * (older bridge) — never throws inside the fallback when `continueOnError` is
   * true; failures land as per-item `error` fields, mirroring the bridge shape.
   */
  async readParameterModesBatchWithFallback(
    items: Array<{ path: string; keys?: string[]; nonDefaultOnly?: boolean }>,
    continueOnError = true,
  ) {
    const { tryEndpoint } = await import("./types.js");
    return tryEndpoint(
      () => this.readParameterModesBatch(items, continueOnError),
      async () => {
        const out: Array<z.infer<typeof ParamModesBatchSchema>["items"][number]> = [];
        for (const it of items) {
          try {
            const r = await this.readParameterModes(it.path, it.keys, it.nonDefaultOnly ?? false);
            out.push({
              path: r.path,
              type: r.type,
              name: r.name,
              parameters: r.parameters,
              warnings: r.warnings,
            });
          } catch (err) {
            if (!continueOnError) throw err;
            const message = err instanceof Error ? err.message : String(err);
            out.push({
              path: it.path,
              type: "",
              name: "",
              parameters: [],
              warnings: [],
              error: message,
            });
          }
        }
        return { items: out };
      },
    );
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

  // --- Perform-mode write (survives ALLOW_EXEC=0) ---
  setPerformMode(enabled: boolean): Promise<TdPerformModeState> {
    return this.request("POST", "/api/perform", PerformModeStateSchema, { enabled });
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

  /** Load a `.toe`/`.tox` artifact in a QUARANTINE TD and report its tree.
   *
   * SAFETY: only ever point this at a separate quarantine bridge (default 9981);
   * `bridgeAnalyze.ts` is the sole caller and hard-rejects the main port 9980.
   *
   * Prefers the first-class `POST /api/project/load` route; on a 404 (older
   * bridge that predates the route) falls back to a single `/api/exec` pass that
   * runs `project.load` and prints the same report. The exec fallback fails when
   * the bridge has `TDMCP_BRIDGE_ALLOW_EXEC=0`, in which case the caller surfaces
   * a friendly error — exactly as before this route existed.
   */
  async loadProject(path: string, timeoutMs?: number): Promise<TdProjectLoad> {
    const { tryEndpoint } = await import("./types.js");
    return tryEndpoint(
      () =>
        this.request("POST", "/api/project/load", ProjectLoadSchema, {
          path,
          timeout_ms: timeoutMs ?? null,
        }),
      () => this.loadProjectViaExec(path),
    );
  }

  /** Exec-path fallback for {@link loadProject} — runs `project.load` + tree walk
   * inside TD and recovers the same report from stdout. */
  private async loadProjectViaExec(path: string): Promise<TdProjectLoad> {
    const b64 = Buffer.from(JSON.stringify({ path }), "utf8").toString("base64");
    const script = LOAD_PROJECT_EXEC_SCRIPT.replace("__PAYLOAD_B64__", b64);
    const exec = await this.executePythonScript(script, true);
    const report = parseStdoutJson(exec.stdout);
    const parsed = ProjectLoadSchema.safeParse(report);
    if (!parsed.success) {
      throw new TdApiError(`Unexpected loadProject report shape: ${parsed.error.message}`);
    }
    return parsed.data;
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
