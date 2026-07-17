import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { type Logger, silentLogger } from "../utils/logger.js";
import {
  type RepositionContext,
  type RepositionContextRequest,
  type RepositionFailureReceipt,
  type RepositionReceipt,
  type RepositionRequest,
  repositionContextSchema,
  repositionFailureReceiptSchema,
  repositionReceiptSchema,
} from "./editorPlacementValidators.js";
import {
  type OperationCommit,
  type OperationPlan,
  type OperationReceiptRequest,
  operationCommitReceiptSchema,
  operationCommitSchema,
  operationPlanSchema,
  operationPreviewSchema,
  operationReceiptEnvelopeSchema,
  operationReceiptRequestSchema,
} from "./operationPlanValidators.js";
import {
  isMissingEndpoint,
  TdApiError,
  TdBackpressureError,
  TdConnectionError,
  TdTimeoutError,
  tryEndpoint,
} from "./types.js";
import {
  AdvancedCaptureSchema,
  AnnotationEditInputSchema,
  AnnotationEditResultSchema,
  AnnotationLayoutApplyResultSchema,
  AnnotationLayoutContextSchema,
  ApiEnvelopeSchema,
  ArtistWorkspaceReceiptSchema,
  BatchResultSchema,
  BridgeLogsSchema,
  type CaptureAdvancedInput,
  ConnectResultSchema,
  type CreateNodeInput,
  CreateNodeInputSchema,
  CustomParameterLifecycleResultSchema,
  CustomParamsSchema,
  DatTextEditSchema,
  DatTextSchema,
  DatTextWriteSchema,
  DeleteResultSchema,
  DisconnectResultSchema,
  DuplicateNodeSchema,
  EditNodeMetadataResultSchema,
  EditorContextSchema,
  EditorFocusSchema,
  EditorInsertResultSchema,
  ExecResultSchema,
  HealthSchema,
  InfoSchema,
  InteractionStatusSchema,
  InteractionSummarySchema,
  MethodResultSchema,
  NodeDetailSchema,
  NodeErrorsSchema,
  NodeListSchema,
  NodeRefSchema,
  NodeSearchResultSchema,
  OAuthConsentConsumeSchema,
  OpTypesSchema,
  PackageNamespaceApplyResultSchema,
  PackageNamespacePlanSchema,
  ParameterMenuSchema,
  ParameterSearchResultSchema,
  ParameterSequencesSchema,
  ParameterSequenceUpdateSchema,
  ParamModesBatchSchema,
  ParamModesSchema,
  ParamWatchListSchema,
  ParamWatchResultSchema,
  PerformanceSchema,
  PerformModeStateSchema,
  PreviewJobSchema,
  PreviewSchema,
  ProjectAnalysisSchema,
  ProjectLoadSchema,
  ProjectSaveResultSchema,
  PulseParameterResultSchema,
  SampleGridSchema,
  SaveNodeSchema,
  SetParamModeResultSchema,
  SystemInfoSchema,
  type TdAnnotationEditInput,
  type TdAnnotationLayoutApplyResult,
  type TdAnnotationLayoutContext,
  type TdArtistWorkspaceReceipt,
  type TdArtistWorkspaceRequest,
  type TdBatchOperation,
  type TdCustomParameterLifecycleResult,
  type TdCustomParams,
  type TdDuplicateNode,
  type TdEditorInsertResult,
  type TdInteractionStatus,
  type TdOpTypes,
  type TdPackageNamespaceApplyResult,
  type TdPackageNamespacePlan,
  type TdParameterMenu,
  type TdParamWatchList,
  type TdParamWatchResult,
  type TdPerformModeState,
  type TdProjectAnalysis,
  type TdProjectLoad,
  type TdSaveNode,
  type TdSystemInfo,
  type TdToxExportResult,
  type TdToxRoundtripResult,
  TopologySchema,
  ToxExportResultSchema,
  ToxRoundtripResultSchema,
  TransportStateSchema,
  VisualParameterCommitSchema,
  VisualParameterInspectionSchema,
  VisualParameterRestoreSchema,
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

export interface TdReadRequestOptions {
  timeoutMs?: number;
  retryGet?: boolean;
  signal?: AbortSignal;
}

export interface TdOAuthConsentRequest {
  transactionId: string;
  clientId: string;
  clientName?: string;
  redirectUri: string;
  registeredRedirectUris: readonly string[];
  allowedRedirectOrigins: readonly string[];
  resource: string;
  scopes: readonly ["tdmcp:access"];
  ttlSeconds: number;
  signal?: AbortSignal;
}

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

/** Reads the bridge's `error.retry_after` (seconds) from a 503 body, if present. */
function readRetryAfterSeconds(json: unknown): number | undefined {
  if (!json || typeof json !== "object") return undefined;
  const error = (json as Record<string, unknown>).error;
  if (!error || typeof error !== "object") return undefined;
  const value = (error as Record<string, unknown>).retry_after;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Resolves a retry delay (ms) for a 503 from the body's retry_after or a default. */
function extractRetryAfterMs(json: unknown): number {
  const seconds = readRetryAfterSeconds(json);
  if (seconds !== undefined) return Math.max(0, Math.round(seconds * 1000));
  return 2000;
}

function extractApiErrorCode(json: unknown): string | undefined {
  if (!json || typeof json !== "object") return undefined;
  const error = (json as Record<string, unknown>).error;
  if (!error || typeof error !== "object") return undefined;
  const code = (error as Record<string, unknown>).code;
  return typeof code === "string" && code.length > 0 ? code : undefined;
}

function extractValidatedErrorDetails<T>(
  json: unknown,
  schema: z.ZodType<T> | undefined,
): T | undefined {
  if (!schema || !json || typeof json !== "object") return undefined;
  const error = (json as Record<string, unknown>).error;
  if (!error || typeof error !== "object") return undefined;
  const parsed = schema.safeParse((error as Record<string, unknown>).details);
  return parsed.success ? parsed.data : undefined;
}

/** Throws the right typed error for a non-2xx response (backpressure 503 vs generic API error). */
function throwForHttpError(
  response: Response,
  json: unknown,
  method: string,
  path: string,
  errorDetailsSchema?: z.ZodType<unknown>,
): void {
  if (response.status === 503) {
    const retryAfterMs = extractRetryAfterMs(json);
    throw new TdBackpressureError(
      extractErrorMessage(json) ??
        `TouchDesigner is busy (HTTP 503) for ${method} ${path}; retry in ~${retryAfterMs}ms.`,
      { retryAfterMs },
    );
  }
  if (!response.ok) {
    throw new TdApiError(
      extractErrorMessage(json) ??
        `TouchDesigner bridge returned HTTP ${response.status} for ${method} ${path}.`,
      {
        status: response.status,
        apiCode: extractApiErrorCode(json),
        details: extractValidatedErrorDetails(json, errorDetailsSchema),
      },
    );
  }
}

function requestInit(
  method: string,
  body: unknown,
  signal: AbortSignal,
  token: string | undefined,
): RequestInit {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  return {
    method,
    signal,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  };
}

async function fetchResponseText(
  fetchImpl: typeof fetch,
  logger: Logger,
  baseUrl: string,
  method: string,
  url: URL,
  path: string,
  init: RequestInit,
  effectiveTimeoutMs: number,
  externalSignal: AbortSignal | undefined,
  deadlineElapsed: () => boolean,
): Promise<{ response: Response; text: string }> {
  try {
    logger.debug(`TD ${method} ${path}`);
    const response = await fetchImpl(url, init);
    // Keep the same deadline active while consuming the body. A bridge can
    // return headers and then stall; clearing the timer before text() would
    // make a supposedly bounded probe wait forever.
    return { response, text: await response.text() };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      if (externalSignal?.aborted && !deadlineElapsed()) {
        const cancelled = new Error("cancelled");
        cancelled.name = "AbortError";
        throw cancelled;
      }
      throw new TdTimeoutError(
        `TouchDesigner request timed out after ${effectiveTimeoutMs}ms (${method} ${path}).`,
        { cause: err },
      );
    }
    throw new TdConnectionError(
      `Cannot reach TouchDesigner at ${baseUrl}. Make sure TD is running with the tdmcp bridge (WebServer DAT) installed and listening on that port.`,
      { cause: err },
    );
  }
}

function responseJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function parseSuccessfulResponse<T>(
  response: Response,
  json: unknown,
  method: string,
  path: string,
  schema: z.ZodType<T>,
  errorDetailsSchema?: z.ZodType<unknown>,
): T {
  throwForHttpError(response, json, method, path, errorDetailsSchema);
  const envelope = ApiEnvelopeSchema.safeParse(json);
  if (!envelope.success) {
    throw new TdApiError(`Malformed response from TouchDesigner bridge for ${method} ${path}.`, {
      status: response.status,
    });
  }
  if (!envelope.data.ok) {
    throw new TdApiError(
      envelope.data.error?.message ?? `TouchDesigner reported an error for ${method} ${path}.`,
      {
        status: response.status,
        apiCode: envelope.data.error?.code,
        details: extractValidatedErrorDetails(json, errorDetailsSchema),
      },
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
_ext = os.path.splitext(_path)[1].lower()
if not _path or not os.path.isabs(_path) or _ext not in (".toe", ".tox") or not os.path.exists(_path):
    raise ValueError("Field 'path' must be an existing absolute .toe/.tox file: %r" % _path)
def _root():
    try:
        kids = [c for c in op("/").children if bool(getattr(c, "isCOMP", False))]
        if kids:
            return kids[0].path
    except Exception:
        pass
    return "/project1"
# .tox is a component, not a project — import it into a fresh COMP via loadTox
# instead of project.load (which is the .toe project-file path).
if _ext == ".tox":
    _holder = op("/").create(baseCOMP, "prag_tox_load")
    _holder.loadTox(_path)
    _rp = _holder.path
else:
    project.load(_path)
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

/** Exec fallback for `saveNode` on older bridges (no `/api/nodes/<path>/save`).
 * Mirrors `save_service.save_node`: `op.save(file)`, normalize the return
 * (COMP.save -> str; TOP.save -> FileSaveStatus), report dimensions only for
 * image ops, and print the report as the final JSON line. */
const SAVE_NODE_EXEC_SCRIPT = `
import base64, json
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
_n = op(_p["path"])
if _n is None:
    print(json.dumps({"fatal": "save: node not found: " + _p["path"]}))
elif not hasattr(_n, "save"):
    print(json.dumps({"fatal": "save: " + _p["path"] + " cannot be saved (no .save method)."}))
else:
    try:
        _ret = _n.save(_p["file"], createFolders=bool(_p.get("createFolders", True)))
        _saved = str(_ret) if (_ret is not None and str(_ret).strip()) else _p["file"]
        _out = {"path": _n.path, "saved": _saved, "has_dimensions": False}
        if hasattr(_n, "width") and hasattr(_n, "height"):
            try:
                _out["width"] = int(_n.width)
                _out["height"] = int(_n.height)
                _out["has_dimensions"] = True
            except Exception:
                _out["has_dimensions"] = False
        print(json.dumps(_out))
    except Exception as _e:
        print(json.dumps({"fatal": "save: " + _p["path"] + " failed: " + str(_e)}))
`;

/** Exec fallback for `duplicateNode` on older bridges (no `/api/duplicate`).
 * Mirrors `duplicate_service.duplicate`: resolve src + parent, `parent.copy`,
 * print `{source, copy, parent}`. */
const DUPLICATE_NODE_EXEC_SCRIPT = `
import base64, json
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
_src = op(_p["source"])
if _src is None:
    print(json.dumps({"fatal": "duplicate: source not found: " + _p["source"]}))
else:
    _parent = op(_p["parent"]) if _p.get("parent") else _src.parent()
    if _parent is None:
        print(json.dumps({"fatal": "duplicate: parent not found"}))
    else:
        try:
            _new = _parent.copy(_src, name=_p["name"]) if _p.get("name") else _parent.copy(_src)
            print(json.dumps({"source": _src.path, "copy": _new.path, "parent": _parent.path}))
        except Exception as _e:
            print(json.dumps({"fatal": "duplicate failed: " + str(_e)}))
`;

/** Exec fallback for `getOpTypes` on older bridges (no `/api/optypes`).
 * Mirrors `optypes_service.list_optypes`: walk the `td` module for lowercase
 * attributes that subclass a family base class, grouped by family. */
const OPTYPES_EXEC_SCRIPT = `
import json, inspect, td
_FAM = ("TOP", "CHOP", "SOP", "DAT", "COMP", "MAT", "POP")
_bases = {f: getattr(td, f, None) for f in _FAM}
_families = {f: [] for f in _FAM}
for _name in dir(td):
    if not _name or not _name[0].islower():
        continue
    _obj = getattr(td, _name, None)
    if not inspect.isclass(_obj):
        continue
    for _f in _FAM:
        _b = _bases[_f]
        if _b is not None:
            try:
                _is = issubclass(_obj, _b)
            except Exception:
                _is = False
            if _is:
                _families[_f].append(_name)
                break
_families = {f: sorted(v) for f, v in _families.items() if v}
_all = sorted(x for v in _families.values() for x in v)
_info = {}
try:
    _info["td_version"] = str(app.version)
except Exception:
    pass
try:
    _info["build"] = str(app.build)
except Exception:
    pass
print(json.dumps({"optypes": _all, "families": _families, "count": len(_all), **_info}))
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

  private requestAttemptLimit(method: string, retryGet: boolean): number {
    return method === "GET" && retryGet ? this.retries + 1 : 1;
  }

  private requestUrl(path: string, query?: QueryParams): URL {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url;
  }

  private shouldRetry(error: unknown, attempt: number, maxAttempts: number): boolean {
    if (attempt >= maxAttempts) return false;
    if (error instanceof TdConnectionError) return true;
    return error instanceof TdApiError && typeof error.status === "number" && error.status >= 500;
  }

  private async backoffRetry(
    error: unknown,
    method: string,
    path: string,
    attempt: number,
    maxAttempts: number,
  ): Promise<void> {
    const failure =
      error instanceof TdApiError && error.status ? `failed ${error.status}` : "connection failed";
    this.logger.debug(
      `TD ${method} ${path} ${failure} (attempt ${attempt}/${maxAttempts}); retrying`,
    );
    await sleep(this.retryDelayMs * attempt);
  }

  private async request<T>(
    method: string,
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
    query?: QueryParams,
    timeoutMs?: number,
    retryGet = true,
    signal?: AbortSignal,
    errorDetailsSchema?: z.ZodType<unknown>,
  ): Promise<T> {
    const url = this.requestUrl(path, query);

    // Retry a transient connection failure only for idempotent GETs — a TD that
    // briefly stalls mid-build shouldn't abort the whole operation. Timeouts and
    // bridge/API errors are never retried (a timeout may mean the request was
    // received; non-GET methods aren't safe to repeat).
    const maxAttempts = this.requestAttemptLimit(method, retryGet);
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (signal?.aborted) {
        const cancelled = new Error("cancelled");
        cancelled.name = "AbortError";
        throw cancelled;
      }
      try {
        return await this.attemptRequest(
          method,
          url,
          path,
          schema,
          body,
          timeoutMs,
          signal,
          errorDetailsSchema,
        );
      } catch (err) {
        lastError = err;
        if (!this.shouldRetry(err, attempt, maxAttempts)) throw err;
        await this.backoffRetry(err, method, path, attempt, maxAttempts);
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
    timeoutMs?: number,
    externalSignal?: AbortSignal,
    errorDetailsSchema?: z.ZodType<unknown>,
  ): Promise<T> {
    const controller = new AbortController();
    const effectiveTimeoutMs = Math.max(1, timeoutMs ?? this.timeoutMs);
    let deadlineElapsed = false;
    const timer = setTimeout(() => {
      deadlineElapsed = true;
      controller.abort();
    }, effectiveTimeoutMs);
    const onExternalAbort = () => controller.abort();
    externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
    if (externalSignal?.aborted) controller.abort();
    let result: { response: Response; text: string };
    try {
      result = await fetchResponseText(
        this.fetchImpl,
        this.logger,
        this.baseUrl,
        method,
        url,
        path,
        requestInit(method, body, controller.signal, this.token),
        effectiveTimeoutMs,
        externalSignal,
        () => deadlineElapsed,
      );
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    }
    return parseSuccessfulResponse(
      result.response,
      responseJson(result.text),
      method,
      path,
      schema,
      errorDetailsSchema,
    );
  }

  getInfo(options: TdReadRequestOptions = {}) {
    return this.request(
      "GET",
      "/api/info",
      InfoSchema,
      undefined,
      undefined,
      options.timeoutMs,
      options.retryGet,
      options.signal,
    );
  }

  /** Bridge liveness/uptime/heartbeat report (`GET /api/health`). */
  getHealth() {
    return this.request("GET", "/api/health", HealthSchema);
  }

  /** Content-free readiness summary for the bounded native interaction broker. */
  getInteractionSummary() {
    return this.request("GET", "/api/interactions/status", InteractionSummarySchema);
  }

  /** Read-only exact-state preview for one bounded structured graph operation. */
  previewOperation(input: OperationPlan, options: TdReadRequestOptions = {}) {
    const parsed = operationPlanSchema.parse(input);
    return this.request(
      "POST",
      "/api/operations/preview",
      operationPreviewSchema,
      parsed,
      undefined,
      options.timeoutMs ?? 5_000,
      false,
      options.signal,
    );
  }

  /** Commit exactly one previewed operation; POST is never retried implicitly. */
  commitOperation(input: OperationCommit, options: TdReadRequestOptions = {}) {
    const parsed = operationCommitSchema.parse(input);
    return this.request(
      "POST",
      "/api/operations/commit",
      operationCommitReceiptSchema,
      parsed,
      undefined,
      options.timeoutMs ?? 10_000,
      false,
      options.signal,
    );
  }

  /** Recover a terminal receipt and fresh exact journal observation by capability. */
  getOperationReceipt(input: OperationReceiptRequest, options: TdReadRequestOptions = {}) {
    const parsed = operationReceiptRequestSchema.parse(input);
    return this.request(
      "POST",
      "/api/operations/receipt",
      operationReceiptEnvelopeSchema,
      parsed,
      undefined,
      options.timeoutMs ?? 5_000,
      false,
      options.signal,
    );
  }

  async createNode(input: CreateNodeInput) {
    const parsed = CreateNodeInputSchema.parse(input);
    const result = await this.request("POST", "/api/nodes", NodeRefSchema, parsed);
    this.assertCreateStateConfirmed(parsed, result);
    return result;
  }

  private assertCreateStateConfirmed(
    input: CreateNodeInput,
    result: z.infer<typeof NodeRefSchema>,
  ) {
    if (result.already_existed === true) return;
    if (input.placement !== undefined) {
      const coordinatesPresent =
        typeof result.nodeX === "number" && typeof result.nodeY === "number";
      const coordinatesExact =
        input.placement !== "explicit" ||
        (result.nodeX === input.node_x && result.nodeY === input.node_y);
      if (!coordinatesPresent || !coordinatesExact) {
        throw new TdApiError("TouchDesigner did not confirm the requested node placement.", {
          apiCode: "create_state_unconfirmed",
        });
      }
    }
    if (input.viewer !== undefined && result.viewer !== input.viewer) {
      throw new TdApiError("TouchDesigner did not confirm the requested node viewer state.", {
        apiCode: "create_state_unconfirmed",
      });
    }
  }

  async deleteNode(
    path: string,
    mode: "delete" | "bypass" = "delete",
    options: { confirmationPolicy?: "native" | "yolo"; timeoutMs?: number } = {},
  ) {
    if (mode === "bypass") {
      return this.request("DELETE", `/api/nodes/${segment(path)}`, DeleteResultSchema, undefined, {
        mode: "bypass",
        confirmation_policy: "explicit_mode",
      });
    }
    if (options.confirmationPolicy === "yolo") {
      return this.request("DELETE", `/api/nodes/${segment(path)}`, DeleteResultSchema, undefined, {
        mode: "delete",
        confirmation_policy: "yolo",
      });
    }

    await this.getNode(path);
    const interaction = await this.createInteraction(
      "delete_node",
      { path },
      options.timeoutMs ?? 30_000,
    );
    const status = await this.waitForInteraction(interaction, options.timeoutMs ?? 30_000);
    const choice = status.state === "resolved" ? status.result?.choice : "Keep";
    if (choice !== "Delete" && choice !== "Bypass") {
      return DeleteResultSchema.parse({
        mode: "delete",
        decision: "Keep",
        original_path: path,
        final_path: path,
        action_applied: "keep",
        applied: false,
        request_id: interaction.request_id,
        confirmation_policy: "native",
      });
    }
    return this.request("DELETE", `/api/nodes/${segment(path)}`, DeleteResultSchema, undefined, {
      mode: choice === "Bypass" ? "bypass" : "delete",
      confirmation_policy: "native",
      interaction_id: interaction.request_id,
    });
  }

  getEditorContext(options: { timeoutMs?: number; retry?: boolean; signal?: AbortSignal } = {}) {
    return this.request(
      "GET",
      "/api/editor/context",
      EditorContextSchema,
      undefined,
      undefined,
      options.timeoutMs,
      options.retry,
      options.signal,
    );
  }

  insertOperatorAtSelection(input: {
    type: string;
    name?: string;
    parameters?: Record<string, unknown>;
    expected_context: {
      owner_path: string;
      selected_path: string;
      current_path: string;
    };
    idempotency_key: string;
  }): Promise<TdEditorInsertResult> {
    return this.request("POST", "/api/editor/insert", EditorInsertResultSchema, input);
  }

  applyCustomParameterLifecycle(
    compPath: string,
    body: {
      page?: string;
      params?: unknown[];
      operations?: unknown[];
      idempotency_key?: string;
    },
  ): Promise<TdCustomParameterLifecycleResult> {
    return this.request(
      "POST",
      `/api/nodes/${segment(compPath)}/custom_params`,
      CustomParameterLifecycleResultSchema,
      body,
    );
  }

  pulseParameter(path: string, parameter: string) {
    return this.request(
      "POST",
      `/api/nodes/${segment(path)}/params/${encodeURIComponent(parameter)}/pulse`,
      PulseParameterResultSchema,
    );
  }

  getParameterMenu(
    path: string,
    parameter: string,
    options: TdReadRequestOptions = {},
  ): Promise<TdParameterMenu> {
    return this.request(
      "GET",
      `/api/nodes/${segment(path)}/params/${segment(parameter)}/menu`,
      ParameterMenuSchema,
      undefined,
      undefined,
      options.timeoutMs,
      options.retryGet ?? true,
      options.signal,
    );
  }

  getParameterSequences(path: string) {
    return this.request(
      "GET",
      `/api/nodes/${segment(path)}/params/sequences`,
      ParameterSequencesSchema,
    );
  }

  updateParameterSequences(
    path: string,
    input: { sequences?: Record<string, number>; parameters?: Record<string, unknown> },
  ) {
    return this.request(
      "PATCH",
      `/api/nodes/${segment(path)}/params/sequences`,
      ParameterSequenceUpdateSchema,
      {
        sequences: input.sequences ?? {},
        parameters: input.parameters ?? {},
      },
    );
  }

  editNodeMetadata(input: {
    path: string;
    name?: string;
    parent_path?: string;
    node_x?: number;
    node_y?: number;
    color?: [number, number, number];
    comment?: string;
    display?: boolean;
    render?: boolean;
    viewer?: boolean;
    bypass?: boolean;
    lock?: boolean;
    cloneImmune?: boolean;
    allowCooking?: boolean;
  }) {
    const { path, ...changes } = input;
    return this.request(
      "PATCH",
      `/api/nodes/${segment(path)}/metadata`,
      EditNodeMetadataResultSchema,
      changes,
    );
  }

  editAnnotation(path: string, changes: TdAnnotationEditInput) {
    const parsed = AnnotationEditInputSchema.parse(changes);
    return this.request(
      "PATCH",
      `/api/nodes/${segment(path)}/annotation`,
      AnnotationEditResultSchema,
      parsed,
    );
  }

  getAnnotationLayoutContext(
    rootPath: string,
    recursive = false,
  ): Promise<TdAnnotationLayoutContext> {
    return this.request(
      "POST",
      "/api/editor/annotation-layout/context",
      AnnotationLayoutContextSchema,
      { root_path: rootPath, recursive },
    );
  }

  applyAnnotationLayout(input: {
    root_path: string;
    recursive: boolean;
    fingerprint: string;
    networks: Array<{
      path: string;
      positions: Record<string, [number, number]>;
      annotation_bounds: Record<
        string,
        { x: number; y: number; w: number; h: number; resized?: boolean }
      >;
    }>;
  }): Promise<TdAnnotationLayoutApplyResult> {
    return this.request(
      "POST",
      "/api/editor/annotation-layout/apply",
      AnnotationLayoutApplyResultSchema,
      input,
    );
  }

  getRepositionContext(input: RepositionContextRequest): Promise<RepositionContext> {
    return this.request("POST", "/api/editor/reposition/context", repositionContextSchema, input);
  }

  applyReposition(input: RepositionRequest): Promise<RepositionReceipt> {
    return this.request(
      "POST",
      "/api/editor/reposition",
      repositionReceiptSchema,
      input,
      undefined,
      undefined,
      false,
      undefined,
      repositionFailureReceiptSchema as z.ZodType<RepositionFailureReceipt>,
    );
  }

  private workspaceTransportKey(action: "open" | "restore" | "cancel"): string {
    return `${action}_${randomUUID().replaceAll("-", "")}`;
  }

  private getArtistWorkspaceStatus(
    workspaceId: string,
    timeoutMs: number,
  ): Promise<TdArtistWorkspaceReceipt> {
    return this.request(
      "GET",
      `/api/editor/workspaces/${encodeURIComponent(workspaceId)}`,
      ArtistWorkspaceReceiptSchema,
      undefined,
      undefined,
      timeoutMs,
      false,
    );
  }

  private async pollArtistWorkspace(
    workspaceId: string,
    action: "open" | "restore" | "cancel",
  ): Promise<TdArtistWorkspaceReceipt> {
    const deadline = Date.now() + 1_500;
    while (Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now());
      const receipt = await this.getArtistWorkspaceStatus(workspaceId, remaining);
      const pending = new Set([
        "scheduled",
        "restore_scheduled",
        "cancel_scheduled",
        "cleanup_scheduled",
      ]);
      if (!pending.has(receipt.status)) return receipt;
      await sleep(Math.min(50, Math.max(1, deadline - Date.now())));
    }
    throw new TdTimeoutError(
      `TouchDesigner artist workspace ${action} polling timed out after 1500ms.`,
    );
  }

  private async bestEffortWorkspaceCancel(workspaceId: string): Promise<void> {
    try {
      await this.request(
        "POST",
        `/api/editor/workspaces/${encodeURIComponent(workspaceId)}/cancel`,
        ArtistWorkspaceReceiptSchema,
        { idempotency_key: this.workspaceTransportKey("cancel") },
        undefined,
        250,
        false,
      );
    } catch {
      // The bounded lease remains authoritative if best-effort cancellation is lost.
    }
  }

  private async beginArtistWorkspaceAction(
    action: "open" | "restore" | "cancel",
    path: string,
    body: Record<string, unknown>,
  ): Promise<TdArtistWorkspaceReceipt> {
    try {
      return await this.request(
        "POST",
        path,
        ArtistWorkspaceReceiptSchema,
        body,
        undefined,
        1_500,
        false,
      );
    } catch (error) {
      const responseMayBeLost =
        error instanceof TdConnectionError || error instanceof TdTimeoutError;
      if (!responseMayBeLost) throw error;
      // Exactly one recovery attempt, with the identical transport key/body. The
      // bridge either deduplicates the completed action or starts it once; a new
      // key is never generated for an ambiguous initial response. Status polling
      // (and the server-side lease) remains authoritative after the retry.
      this.logger.debug(
        `TD artist workspace ${action} response may be lost; retrying once with the same idempotency key`,
      );
      return this.request(
        "POST",
        path,
        ArtistWorkspaceReceiptSchema,
        body,
        undefined,
        1_500,
        false,
      );
    }
  }

  async manageArtistWorkspace(input: TdArtistWorkspaceRequest): Promise<TdArtistWorkspaceReceipt> {
    if (input.action === "status") {
      return this.getArtistWorkspaceStatus(input.workspace_id, 1_500);
    }

    const path =
      input.action === "open"
        ? "/api/editor/workspaces"
        : `/api/editor/workspaces/${encodeURIComponent(input.workspace_id)}/${input.action}`;
    const idempotencyKey = this.workspaceTransportKey(input.action);
    const body =
      input.action === "open"
        ? {
            network_path: input.network_path,
            viewer_path: input.viewer_path,
            viewer_mode: input.viewer_mode,
            split_ratio: input.split_ratio ?? 0.62,
            lease_seconds: input.lease_seconds ?? 300,
            idempotency_key: idempotencyKey,
          }
        : { idempotency_key: idempotencyKey };
    const initial = await this.beginArtistWorkspaceAction(input.action, path, body);
    const pending = new Set([
      "scheduled",
      "restore_scheduled",
      "cancel_scheduled",
      "cleanup_scheduled",
    ]);
    if (!pending.has(initial.status)) return initial;
    try {
      return await this.pollArtistWorkspace(initial.workspace_id, input.action);
    } catch (error) {
      await this.bestEffortWorkspaceCancel(initial.workspace_id);
      throw error;
    }
  }

  async saveProject(input: { path?: string; confirmation_timeout_ms?: number }) {
    try {
      return await this.request(
        "POST",
        "/api/project/save",
        ProjectSaveResultSchema,
        input.path === undefined ? {} : { path: input.path },
      );
    } catch (error) {
      const needsConsent =
        error instanceof TdApiError &&
        error.message.includes("existing Save As target requires resolved Overwrite approval");
      if (!needsConsent || input.path === undefined) throw error;
    }

    const timeoutMs = input.confirmation_timeout_ms ?? 30_000;
    const interaction = await this.createInteraction(
      "save_overwrite",
      { path: input.path },
      timeoutMs,
    );
    const status = await this.waitForInteraction(interaction, timeoutMs);
    const choice = status.state === "resolved" ? status.result?.choice : "Keep";
    if (choice !== "Overwrite") {
      return ProjectSaveResultSchema.parse({
        requested_path: input.path,
        final_path: null,
        decision: "Keep",
        verified_exists: false,
        saved: false,
        action_applied: false,
        request_id: interaction.request_id,
      });
    }
    return this.request("POST", "/api/project/save", ProjectSaveResultSchema, {
      path: input.path,
      interaction_id: interaction.request_id,
    });
  }

  private createInteraction(
    kind:
      | "delete_node"
      | "save_overwrite"
      | "artifact_overwrite"
      | "oauth_client_consent"
      | "visual_parameter_apply",
    target: Record<string, unknown>,
    timeoutMs: number,
    dedupeKey: string = randomUUID(),
    signal?: AbortSignal,
  ) {
    return this.request(
      "POST",
      "/api/interactions",
      InteractionStatusSchema,
      {
        kind,
        target,
        ttl_seconds: Math.max(5, Math.min(120, timeoutMs / 1000)),
        dedupe_key: dedupeKey,
      },
      undefined,
      Math.min(2_000, timeoutMs),
      false,
      signal,
    );
  }

  private async waitForInteraction(
    initial: TdInteractionStatus,
    timeoutMs: number,
    safeChoice = "Keep",
    signal?: AbortSignal,
  ): Promise<TdInteractionStatus> {
    let current = initial;
    // The bridge TTL itself stays within 5..120s. The caller may choose a
    // shorter local deadline; that only cancels the ticket and fails closed.
    const boundedMs = Math.max(1, Math.min(120_000, timeoutMs));
    const deadline = Date.now() + boundedMs;
    while (current.state === "pending" && Date.now() < deadline) {
      if (signal?.aborted) {
        await this.cancelInteractionBestEffort(initial.request_id);
        return {
          ...initial,
          state: "cancelled",
          result: { choice: safeChoice, reason: "client_cancelled", at: Date.now() / 1000 },
        };
      }
      await sleep(Math.min(250, Math.max(1, deadline - Date.now())));
      try {
        current = await this.request(
          "GET",
          `/api/interactions/${segment(initial.request_id)}`,
          InteractionStatusSchema,
          undefined,
          undefined,
          Math.min(1_500, Math.max(1, deadline - Date.now())),
          false,
          signal,
        );
      } catch {
        await this.cancelInteractionBestEffort(initial.request_id);
        return {
          ...initial,
          state: "failed",
          result: { choice: safeChoice, reason: "disconnect", at: Date.now() / 1000 },
        };
      }
    }
    if (current.state === "pending") {
      await this.cancelInteractionBestEffort(initial.request_id);
      return {
        ...current,
        state: "expired",
        result: { choice: safeChoice, reason: "client_timeout", at: Date.now() / 1000 },
      };
    }
    return current;
  }

  async requestDeleteDecision(path: string, timeoutMs = 30_000) {
    const interaction = await this.createInteraction("delete_node", { path }, timeoutMs);
    const status = await this.waitForInteraction(interaction, timeoutMs);
    const choice = status.state === "resolved" ? status.result?.choice : "Keep";
    return {
      request_id: interaction.request_id,
      choice: choice === "Delete" || choice === "Bypass" ? choice : "Keep",
      state: status.state,
    } as const;
  }

  inspectVisualParameters(input: {
    scope_path: string;
    output_top_path: string;
    targets: Array<{
      node_path: string;
      parameter: string;
      minimum: number;
      maximum: number;
    }>;
    signal?: AbortSignal;
  }) {
    const { signal, ...body } = input;
    return this.request(
      "POST",
      "/api/editor/visual-parameters/inspect",
      VisualParameterInspectionSchema,
      body,
      undefined,
      5_000,
      false,
      signal,
    );
  }

  async requestVisualParameterDecision(input: {
    expected_fingerprint: string;
    proposal_digest: string;
    changes: Array<{ target_id: string; value: number }>;
    timeout_ms: number;
    dedupe_key: string;
    signal?: AbortSignal;
  }) {
    const interaction = await this.createInteraction(
      "visual_parameter_apply",
      {
        expected_fingerprint: input.expected_fingerprint,
        proposal_digest: input.proposal_digest,
        changes: input.changes,
      },
      input.timeout_ms,
      input.dedupe_key,
      input.signal,
    );
    const status = await this.waitForInteraction(
      interaction,
      input.timeout_ms,
      "Keep",
      input.signal,
    );
    const choice = status.state === "resolved" ? status.result?.choice : "Keep";
    return {
      request_id: interaction.request_id,
      state: status.state,
      choice: choice === "Apply" ? "Apply" : "Keep",
    } as const;
  }

  commitVisualParameters(input: {
    scope_path: string;
    output_top_path: string;
    expected_fingerprint: string;
    proposal_digest: string;
    idempotency_key: string;
    interaction_id: string;
    changes: Array<{ target_id: string; value: number }>;
    signal?: AbortSignal;
  }) {
    const { signal, ...body } = input;
    return this.request(
      "POST",
      "/api/editor/visual-parameters/commit",
      VisualParameterCommitSchema,
      body,
      undefined,
      5_000,
      false,
      signal,
    );
  }

  restoreVisualParameters(input: {
    restore_token: string;
    expected_committed_fingerprint: string;
    idempotency_key: string;
    signal?: AbortSignal;
  }) {
    const { signal, ...body } = input;
    return this.request(
      "POST",
      "/api/editor/visual-parameters/restore",
      VisualParameterRestoreSchema,
      body,
      undefined,
      5_000,
      false,
      signal,
    );
  }

  /**
   * Request native overwrite consent for a component artifact without mutating it.
   * The caller must still perform its own verified, recoverable promotion and must
   * treat every non-Overwrite terminal state as Keep.
   */
  async requestArtifactOverwriteDecision(
    sourcePath: string,
    targetPath: string,
    timeoutMs = 30_000,
  ) {
    const interaction = await this.createInteraction(
      "artifact_overwrite",
      { source_path: sourcePath, target_path: targetPath },
      timeoutMs,
    );
    const status = await this.waitForInteraction(interaction, timeoutMs);
    const choice = status.state === "resolved" ? status.result?.choice : "Keep";
    return {
      request_id: interaction.request_id,
      choice: choice === "Overwrite" ? "Overwrite" : "Keep",
      state: status.state,
    } as const;
  }

  private async createOAuthConsentInteraction(
    body: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<TdInteractionStatus | undefined> {
    const send = () =>
      this.request(
        "POST",
        "/api/interactions",
        InteractionStatusSchema,
        body,
        undefined,
        Math.min(2_000, timeoutMs),
        false,
        signal,
      );
    try {
      return await send();
    } catch (error) {
      const ambiguous = error instanceof TdConnectionError || error instanceof TdTimeoutError;
      if (!ambiguous) return undefined;
    }
    // The bridge deduplicates this exact transaction id. One response-loss
    // recovery is safe; any second ambiguity denies and never issues a code.
    try {
      return await send();
    } catch {
      return undefined;
    }
  }

  private async consumeOAuthConsent(
    requestId: string,
    target: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<"Allow" | "Deny"> {
    try {
      const consumed = await this.request(
        "POST",
        `/api/oauth/consents/${segment(requestId)}/consume`,
        OAuthConsentConsumeSchema,
        { target },
        undefined,
        Math.min(2_000, timeoutMs),
        false,
        signal,
      );
      return consumed.accepted && consumed.decision === "Allow" ? "Allow" : "Deny";
    } catch {
      return "Deny";
    }
  }

  /**
   * Ask the authenticated TD-native inbox for one bounded OAuth Allow/Deny choice.
   * OAuth state, PKCE material, codes and tokens never cross this bridge boundary.
   */
  async requestOAuthConsent(input: TdOAuthConsentRequest): Promise<"Allow" | "Deny"> {
    const timeoutMs = Math.max(5_000, Math.min(120_000, input.ttlSeconds * 1_000));
    const target = {
      transaction_id: input.transactionId,
      client_id: input.clientId,
      client_name: input.clientName ?? "Unnamed client",
      redirect_uri: input.redirectUri,
      registered_redirect_uris: [...input.registeredRedirectUris],
      allowed_redirect_origins: [...input.allowedRedirectOrigins],
      resource: input.resource,
      scopes: [...input.scopes],
    };
    const body = {
      kind: "oauth_client_consent" as const,
      target,
      ttl_seconds: timeoutMs / 1_000,
      dedupe_key: input.transactionId,
    };

    const interaction = await this.createOAuthConsentInteraction(body, timeoutMs, input.signal);
    if (!interaction) return "Deny";
    const status = await this.waitForInteraction(interaction, timeoutMs, "Deny", input.signal);
    if (status.state !== "resolved") return "Deny";
    return this.consumeOAuthConsent(interaction.request_id, target, timeoutMs, input.signal);
  }

  checkPackageNamespace(input: {
    project_path: string;
    package_id: string;
    source_url: string;
    recorded_ref: string;
    recorded_target_path?: string;
    scope: "user" | "project";
    intent: "prune" | "replace";
  }): Promise<TdPackageNamespacePlan> {
    return this.request("POST", "/api/packages/reconcile/check", PackageNamespacePlanSchema, input);
  }

  applyPackageNamespace(input: {
    plan_id: string;
    choice: "Bypass" | "Delete";
    confirmation_policy: "explicit_mode" | "native" | "yolo";
    interaction_id?: string;
  }): Promise<TdPackageNamespaceApplyResult> {
    return this.request(
      "POST",
      "/api/packages/reconcile/apply",
      PackageNamespaceApplyResultSchema,
      input,
    );
  }

  private async cancelInteractionBestEffort(requestId: string): Promise<void> {
    try {
      await this.request(
        "POST",
        `/api/interactions/${segment(requestId)}/cancel`,
        InteractionStatusSchema,
        { reason: "client_cancelled" },
        undefined,
        1_500,
      );
    } catch {
      // A lost bridge cannot be trusted to mutate. Without final ticket consumption,
      // even a later UI click cannot authorize delete/overwrite.
    }
  }

  startToxRoundtrip(input: {
    path: string;
    expected_contract?: Record<string, unknown>;
    artifact_sha256: string;
    settle_frames: number;
    max_nodes: number;
    max_errors: number;
    max_external_refs: number;
    timeout_ms: number;
  }): Promise<TdToxRoundtripResult> {
    return this.request("POST", "/api/artifacts/tox/roundtrip", ToxRoundtripResultSchema, input);
  }

  getToxRoundtrip(operationId: string): Promise<TdToxRoundtripResult> {
    return this.request(
      "GET",
      `/api/artifacts/tox/roundtrip/${segment(operationId)}`,
      ToxRoundtripResultSchema,
    );
  }

  cancelToxRoundtrip(operationId: string, reason = "client_cancelled") {
    return this.request(
      "POST",
      `/api/artifacts/tox/roundtrip/${segment(operationId)}/cancel`,
      ToxRoundtripResultSchema,
      { reason },
    );
  }

  async exportToxTransaction(input: {
    source_path: string;
    target_path: string;
    mode?: "as_is" | "portable";
    create_folders?: boolean;
    overwrite_policy?: "refuse" | "ask";
    confirmation_timeout_ms?: number;
    operation_timeout_ms?: number;
    idempotency_key?: string;
  }): Promise<TdToxExportResult> {
    const operationTimeoutMs = Math.max(
      1_000,
      Math.min(120_000, input.operation_timeout_ms ?? 60_000),
    );
    const confirmationTimeoutMs = Math.max(
      5_000,
      Math.min(120_000, input.confirmation_timeout_ms ?? 30_000),
    );
    const idempotencyKey = input.idempotency_key ?? randomUUID().replaceAll("-", "_");
    const payload = {
      source_path: input.source_path,
      target_path: input.target_path,
      mode: input.mode ?? "as_is",
      create_folders: input.create_folders ?? false,
      idempotency_key: idempotencyKey,
    };

    let receipt: TdToxExportResult;
    try {
      receipt = await this.startToxExportRequest(payload, operationTimeoutMs);
    } catch (error) {
      const overwriteRequired =
        error instanceof TdApiError && error.apiCode === "artifact_overwrite_required";
      if (!overwriteRequired || (input.overwrite_policy ?? "refuse") !== "ask") throw error;
      const interaction = await this.createInteraction(
        "artifact_overwrite",
        { source_path: input.source_path, target_path: input.target_path },
        confirmationTimeoutMs,
      );
      const status = await this.waitForInteraction(interaction, confirmationTimeoutMs);
      const choice = status.state === "resolved" ? status.result?.choice : "Keep";
      if (choice !== "Overwrite") {
        return ToxExportResultSchema.parse({
          operation_id: interaction.request_id,
          status: "cancelled",
          verdict: "PASS",
          source_path: input.source_path,
          target_path: input.target_path,
          mode: payload.mode,
          decision: "Keep",
          interaction_id: interaction.request_id,
          action_applied: false,
          phases: [],
          error: { code: "cancelled", message: "Overwrite was not approved." },
        });
      }
      receipt = await this.startToxExportRequest(
        { ...payload, interaction_id: interaction.request_id },
        operationTimeoutMs,
      );
    }
    return this.waitForToxExport(receipt, operationTimeoutMs);
  }

  private async startToxExportRequest(
    payload: Record<string, unknown> & { idempotency_key: string },
    timeoutMs: number,
  ): Promise<TdToxExportResult> {
    try {
      return await this.request(
        "POST",
        "/api/artifacts/tox/exports",
        ToxExportResultSchema,
        payload,
        undefined,
        Math.min(2_000, timeoutMs),
      );
    } catch (error) {
      if (!(error instanceof TdTimeoutError) && !(error instanceof TdConnectionError)) throw error;
      try {
        const recovered = await this.request(
          "GET",
          `/api/artifacts/tox/exports/by-key/${segment(payload.idempotency_key)}`,
          ToxExportResultSchema,
          undefined,
          undefined,
          Math.min(1_500, timeoutMs),
          false,
        );
        if (recovered.status !== "expired") return recovered;
      } catch {
        // Preserve the original uncertain POST failure; recovery never retries a mutation.
      }
      throw error;
    }
  }

  private async waitForToxExport(
    initial: TdToxExportResult,
    timeoutMs: number,
  ): Promise<TdToxExportResult> {
    let current = initial;
    const terminal = new Set(["succeeded", "failed", "cancelled", "expired"]);
    const deadline = Date.now() + timeoutMs;
    while (!terminal.has(current.status) && Date.now() < deadline) {
      await sleep(Math.min(250, Math.max(1, deadline - Date.now())));
      current = await this.request(
        "GET",
        `/api/artifacts/tox/exports/${segment(initial.operation_id)}`,
        ToxExportResultSchema,
        undefined,
        undefined,
        Math.min(1_500, Math.max(1, deadline - Date.now())),
        false,
      );
    }
    if (terminal.has(current.status)) return current;
    try {
      return await this.request(
        "POST",
        `/api/artifacts/tox/exports/${segment(initial.operation_id)}/cancel`,
        ToxExportResultSchema,
        { reason: "timeout" },
        undefined,
        1_500,
      );
    } catch {
      return current;
    }
  }

  getNodes(parentPath?: string, options: TdReadRequestOptions = {}) {
    return this.request(
      "GET",
      "/api/nodes",
      NodeListSchema,
      undefined,
      { parent: parentPath },
      options.timeoutMs,
      options.retryGet,
      options.signal,
    );
  }

  /** Compact bridge-side descendant search; never transfers topology or parameters. */
  searchNodes(
    input: {
      rootPath: string;
      pattern?: string;
      nameGlob?: string;
      pathGlob?: string;
      type?: string;
      typeMatch?: "exact" | "contains";
      family?: "TOP" | "CHOP" | "SOP" | "DAT" | "COMP" | "MAT" | "POP";
      maxDepth?: number;
      limit?: number;
      nodeScanLimit?: number;
      timeLimitMs?: number;
    },
    options: TdReadRequestOptions = {},
  ) {
    return this.request(
      "GET",
      "/api/nodes/search",
      NodeSearchResultSchema,
      undefined,
      {
        root: input.rootPath,
        pattern: input.pattern,
        name_glob: input.nameGlob,
        path_glob: input.pathGlob,
        type: input.type,
        type_match: input.typeMatch,
        family: input.family,
        max_depth: input.maxDepth,
        limit: input.limit,
        node_scan_limit: input.nodeScanLimit,
        time_limit_ms: input.timeLimitMs,
      },
      options.timeoutMs,
      options.retryGet,
      options.signal,
    );
  }

  /** Bounded bridge-side parameter search. Filter content stays in the POST body. */
  searchParameters(
    input: {
      rootPath: string;
      maxDepth: number;
      nodePattern?: string;
      nodeNameGlob?: string;
      nodePathGlob?: string;
      type?: string;
      typeMatch: "partial" | "exact";
      family?: "TOP" | "CHOP" | "SOP" | "DAT" | "COMP" | "MAT" | "POP";
      parameterGlob?: string;
      valueGlob?: string;
      expressionGlob?: string;
      mode?: "CONSTANT" | "EXPRESSION" | "EXPORT" | "BIND" | "UNKNOWN";
      nonDefaultOnly: boolean;
      limit: number;
      nodeScanLimit: number;
      parameterScanLimit: number;
      timeBudgetMs: number;
    },
    options: TdReadRequestOptions = {},
  ) {
    return this.request(
      "POST",
      "/api/params/search",
      ParameterSearchResultSchema,
      {
        root_path: input.rootPath,
        max_depth: input.maxDepth,
        node_pattern: input.nodePattern,
        node_name_glob: input.nodeNameGlob,
        node_path_glob: input.nodePathGlob,
        type: input.type,
        type_match: input.typeMatch,
        family: input.family,
        parameter_glob: input.parameterGlob,
        value_glob: input.valueGlob,
        expression_glob: input.expressionGlob,
        mode: input.mode,
        non_default_only: input.nonDefaultOnly,
        limit: input.limit,
        node_scan_limit: input.nodeScanLimit,
        parameter_scan_limit: input.parameterScanLimit,
        time_budget_ms: input.timeBudgetMs,
      },
      undefined,
      options.timeoutMs,
      false,
      options.signal,
    );
  }

  getNode(path: string, options: TdReadRequestOptions = {}) {
    return this.request(
      "GET",
      `/api/nodes/${segment(path)}`,
      NodeDetailSchema,
      undefined,
      undefined,
      options.timeoutMs,
      options.retryGet,
      options.signal,
    );
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

  getPreview(path: string, width = 640, height = 360, options: TdReadRequestOptions = {}) {
    return this.request(
      "GET",
      `/api/preview/${segment(path)}`,
      PreviewSchema,
      undefined,
      { width, height },
      options.timeoutMs,
      options.retryGet,
      options.signal,
    );
  }

  sampleGrid(path: string, grid: number, options: TdReadRequestOptions = {}) {
    return this.request(
      "GET",
      `/api/preview/${segment(path)}`,
      SampleGridSchema,
      undefined,
      { sample_grid: grid },
      options.timeoutMs,
      options.retryGet,
      options.signal,
    );
  }

  captureAdvanced(path: string, opts: CaptureAdvancedInput) {
    return this.request("POST", `/api/preview/${segment(path)}`, AdvancedCaptureSchema, {
      width: opts.width,
      height: opts.height,
      sample_grid: opts.sampleGrid,
      pre_pulses: opts.prePulses,
      delay_frames: opts.delayFrames,
    });
  }

  collectPreviewJob(jobId: string) {
    return this.request("GET", `/api/preview_job/${segment(jobId)}`, PreviewJobSchema);
  }

  cancelPreviewJob(jobId: string) {
    return this.request("POST", `/api/preview_job/${segment(jobId)}/cancel`, PreviewJobSchema);
  }

  async focusEditor(
    paths: string[],
    animate: boolean,
    options: {
      action?: "create" | "edit" | "inspect" | "view" | "layout" | "delete";
      framing?: "auto" | "selection" | "owner" | "none";
      enabled?: boolean;
    } = {},
  ) {
    const requestId = randomUUID().replaceAll("-", "_");
    let receipt = await this.request("POST", "/api/editor/focus", EditorFocusSchema, {
      paths,
      animate,
      action: options.action ?? "view",
      framing: options.framing ?? "auto",
      enabled: options.enabled ?? true,
      request_id: requestId,
    });
    if (receipt.status !== "scheduled" || !receipt.operation_id) return receipt;
    const operationId = receipt.operation_id;

    const deadline = Date.now() + 750;
    while (receipt.status === "scheduled" && Date.now() < deadline) {
      await sleep(Math.min(50, Math.max(1, deadline - Date.now())));
      receipt = await this.request(
        "GET",
        `/api/editor/focus/${segment(operationId)}`,
        EditorFocusSchema,
        undefined,
        undefined,
        Math.min(500, Math.max(1, deadline - Date.now())),
        false,
      );
    }
    if (receipt.status !== "scheduled") return receipt;
    try {
      return await this.request(
        "POST",
        `/api/editor/focus/${segment(operationId)}/cancel`,
        EditorFocusSchema,
        {},
        undefined,
        500,
      );
    } catch {
      return receipt;
    }
  }

  batch(operations: TdBatchOperation[]) {
    return this.request("POST", "/api/batch", BatchResultSchema, { operations });
  }

  getNetworkErrors(path: string, options: TdReadRequestOptions = {}) {
    return this.request(
      "GET",
      `/api/network/${segment(path)}/errors`,
      NodeErrorsSchema,
      undefined,
      undefined,
      options.timeoutMs,
      options.retryGet,
      options.signal,
    );
  }

  getNetworkTopology(path: string, recursive = false, options: TdReadRequestOptions = {}) {
    return this.request(
      "GET",
      `/api/network/${segment(path)}/topology`,
      TopologySchema,
      undefined,
      recursive ? { recursive: true } : undefined,
      options.timeoutMs,
      options.retryGet,
      options.signal,
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

  // --- Parameter-change watches (opt-in; survive TDMCP_BRIDGE_ALLOW_EXEC=0) ---
  /** Register a `param.changed` watch on an operator's parameters.
   *
   * `POST /api/params/watch`. With no `pars` the whole operator is watched;
   * otherwise only the named parameters. Change events surface on the existing
   * WebSocket event stream as `param.changed` (validated by
   * {@link ParamChangedEventSchema}) — this call only registers the subscription.
   *
   * Missing-endpoint handling: an older bridge that predates the Parameter
   * Execute DAT has no way to emit these events, so a missing route becomes a
   * descriptive `TdApiError` telling the artist to reinstall/update the bridge —
   * there is no exec fallback because the event plumbing (not just a Python
   * one-shot) is what's missing. Older bridges report an unknown route as an
   * HTTP 400 `Unsupported POST /api/params/watch`, not 404, so this uses the
   * shared `isMissingEndpoint()` helper (which matches both) rather than checking
   * status 404 alone.
   */
  async watchParameters(path: string, opts?: { pars?: string[] }): Promise<TdParamWatchResult> {
    return this.watchRequest("POST", path, opts?.pars);
  }

  /** Unregister a `param.changed` watch (or specific parameter names) from an op.
   *
   * `DELETE /api/params/watch`. With no `pars` the whole watch is removed;
   * otherwise only the named parameters are dropped from an existing filter. */
  async unwatchParameters(path: string, opts?: { pars?: string[] }): Promise<TdParamWatchResult> {
    return this.watchRequest("DELETE", path, opts?.pars);
  }

  /** List every active parameter watch (`GET /api/params/watch`).
   *
   * Same older-bridge guard as watch/unwatch: an unknown route surfaces as a
   * 404 OR an `Unsupported GET /api/params/watch` 400, so both are mapped to the
   * reinstall/update guidance via `isMissingEndpoint()`. */
  async listParameterWatches(): Promise<TdParamWatchList> {
    try {
      return await this.request("GET", "/api/params/watch", ParamWatchListSchema);
    } catch (err) {
      throw this.mapMissingWatchEndpoint(err);
    }
  }

  /** Shared register/unregister path with the older-bridge missing-route message. */
  private async watchRequest(
    method: "POST" | "DELETE",
    path: string,
    pars?: string[],
  ): Promise<TdParamWatchResult> {
    try {
      return await this.request(method, "/api/params/watch", ParamWatchResultSchema, {
        path,
        pars: pars ?? null,
      });
    } catch (err) {
      throw this.mapMissingWatchEndpoint(err);
    }
  }

  /** Map a missing-route error (404 or `Unsupported <METHOD> ...` 400 on older
   * bridges) to the reinstall/update guidance; rethrow everything else unchanged
   * (a current bridge's real validation error must still surface). */
  private mapMissingWatchEndpoint(err: unknown): unknown {
    if (isMissingEndpoint(err)) {
      return new TdApiError(
        "This TouchDesigner bridge predates parameter-change watching. Reinstall or update the tdmcp bridge (its Parameter Execute DAT emits the param.changed events).",
        { status: err instanceof TdApiError ? err.status : 404, cause: err },
      );
    }
    return err;
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

  putDatText(
    path: string,
    text: string,
    options?: {
      sourcePath?: string;
      language?: "python" | "glsl" | "text" | "json";
      newline?: "preserve" | "lf" | "crlf";
      bom?: "preserve" | "none" | "utf8";
    },
  ) {
    return this.request("PUT", `/api/nodes/${segment(path)}/text`, DatTextWriteSchema, {
      text,
      source_path: options?.sourcePath,
      language: options?.language,
      newline: options?.newline,
      bom: options?.bom,
    });
  }

  editDatText(
    path: string,
    input: {
      oldString: string;
      newString: string;
      replaceAll?: boolean;
      source?: "auto" | "dat" | "file";
    },
  ) {
    return this.request("POST", `/api/nodes/${segment(path)}/text/edit`, DatTextEditSchema, {
      old_string: input.oldString,
      new_string: input.newString,
      replace_all: input.replaceAll ?? false,
      source: input.source ?? "auto",
    });
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

  // --- Node save (survives TDMCP_BRIDGE_ALLOW_EXEC=0) ---
  /** Save a node to a file (`.tox` for a COMP, image for a TOP).
   *
   * Prefers `POST /api/nodes/<path>/save`; on a 404 (older bridge without the
   * route) falls back to a single `/api/exec` pass that runs `op.save(...)` and
   * prints the same report. The exec fallback fails when the bridge has
   * `TDMCP_BRIDGE_ALLOW_EXEC=0`, exactly as before this route existed.
   */
  async saveNode(path: string, file: string, createFolders = true): Promise<TdSaveNode> {
    return tryEndpoint(
      () =>
        this.request("POST", `/api/nodes/${segment(path)}/save`, SaveNodeSchema, {
          file,
          create_folders: createFolders,
        }),
      () => this.saveNodeViaExec(path, file, createFolders),
    );
  }

  /** Exec-path fallback for {@link saveNode} — runs `op.save(...)` in TD and
   * recovers the same report from stdout. */
  private async saveNodeViaExec(
    path: string,
    file: string,
    createFolders: boolean,
  ): Promise<TdSaveNode> {
    const b64 = Buffer.from(JSON.stringify({ path, file, createFolders }), "utf8").toString(
      "base64",
    );
    const script = SAVE_NODE_EXEC_SCRIPT.replace("__PAYLOAD_B64__", b64);
    const exec = await this.executePythonScript(script, true);
    const report = parseStdoutJson(exec.stdout);
    if (report && typeof report === "object" && "fatal" in report) {
      throw new TdApiError(String((report as { fatal: unknown }).fatal));
    }
    const parsed = SaveNodeSchema.safeParse(report);
    if (!parsed.success) {
      throw new TdApiError(`Unexpected saveNode report shape: ${parsed.error.message}`);
    }
    return parsed.data;
  }

  // --- Node/subtree duplicate (survives TDMCP_BRIDGE_ALLOW_EXEC=0) ---
  /** Duplicate a node/subtree preserving its internal wires + params.
   *
   * Prefers `POST /api/duplicate`; on a 404 falls back to a single `/api/exec`
   * pass that runs `parent.copy(src)` and prints the same report. The exec
   * fallback fails under `TDMCP_BRIDGE_ALLOW_EXEC=0`, exactly as before.
   */
  async duplicateNode(
    sourcePath: string,
    name?: string,
    parentPath?: string,
  ): Promise<TdDuplicateNode> {
    return tryEndpoint(
      () =>
        this.request("POST", "/api/duplicate", DuplicateNodeSchema, {
          source_path: sourcePath,
          name: name ?? null,
          parent_path: parentPath ?? null,
        }),
      () => this.duplicateNodeViaExec(sourcePath, name, parentPath),
    );
  }

  /** Exec-path fallback for {@link duplicateNode}. */
  private async duplicateNodeViaExec(
    sourcePath: string,
    name?: string,
    parentPath?: string,
  ): Promise<TdDuplicateNode> {
    const b64 = Buffer.from(
      JSON.stringify({ source: sourcePath, name: name ?? null, parent: parentPath ?? null }),
      "utf8",
    ).toString("base64");
    const script = DUPLICATE_NODE_EXEC_SCRIPT.replace("__PAYLOAD_B64__", b64);
    const exec = await this.executePythonScript(script, true);
    const report = parseStdoutJson(exec.stdout);
    if (report && typeof report === "object" && "fatal" in report) {
      throw new TdApiError(String((report as { fatal: unknown }).fatal));
    }
    const parsed = DuplicateNodeSchema.safeParse(report);
    if (!parsed.success) {
      throw new TdApiError(`Unexpected duplicateNode report shape: ${parsed.error.message}`);
    }
    return parsed.data;
  }

  // --- Creatable-operator truth list (survives TDMCP_BRIDGE_ALLOW_EXEC=0) ---
  /** Enumerate the ground-truth creatable operator types from the live TD.
   *
   * Prefers `GET /api/optypes`; on a 404 falls back to one `/api/exec` pass that
   * walks the `td` module for family-base subclasses and prints the same report.
   */
  async getOpTypes(): Promise<TdOpTypes> {
    return tryEndpoint(
      () => this.request("GET", "/api/optypes", OpTypesSchema),
      () => this.getOpTypesViaExec(),
    );
  }

  /** Exec-path fallback for {@link getOpTypes}. */
  private async getOpTypesViaExec(): Promise<TdOpTypes> {
    const exec = await this.executePythonScript(OPTYPES_EXEC_SCRIPT, true);
    const report = parseStdoutJson(exec.stdout);
    if (report && typeof report === "object" && "fatal" in report) {
      throw new TdApiError(String((report as { fatal: unknown }).fatal));
    }
    const parsed = OpTypesSchema.safeParse(report);
    if (!parsed.success) {
      throw new TdApiError(`Unexpected getOpTypes report shape: ${parsed.error.message}`);
    }
    return parsed.data;
  }
}
