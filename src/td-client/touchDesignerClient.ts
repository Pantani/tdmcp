import type { z } from "zod";
import { type Logger, silentLogger } from "../utils/logger.js";
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
  ApiEnvelopeSchema,
  BatchResultSchema,
  BridgeLogsSchema,
  type CaptureAdvancedInput,
  ConnectResultSchema,
  type CreateNodeInput,
  CreateNodeInputSchema,
  CustomParamsSchema,
  DatTextSchema,
  DatTextWriteSchema,
  DeleteResultSchema,
  DisconnectResultSchema,
  DuplicateNodeSchema,
  EditorFocusSchema,
  ExecResultSchema,
  HealthSchema,
  InfoSchema,
  MethodResultSchema,
  NodeDetailSchema,
  NodeErrorsSchema,
  NodeListSchema,
  NodeRefSchema,
  OpTypesSchema,
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
  SampleGridSchema,
  SaveNodeSchema,
  SetParamModeResultSchema,
  SystemInfoSchema,
  type TdBatchOperation,
  type TdCustomParams,
  type TdDuplicateNode,
  type TdOpTypes,
  type TdParamWatchList,
  type TdParamWatchResult,
  type TdPerformModeState,
  type TdProjectAnalysis,
  type TdProjectLoad,
  type TdSaveNode,
  type TdSystemInfo,
  type TdTopWrite,
  TopologySchema,
  TopWriteSchema,
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

/** Throws the right typed error for a non-2xx response (backpressure 503 vs generic API error). */
function throwForHttpError(response: Response, json: unknown, method: string, path: string): void {
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
      { status: response.status },
    );
  }
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

/** Exec fallback for `writeTopPixels` on older bridges (no `/api/top/write`).
 * Mirrors `top_write_service.write`: resolve/create the Script TOP, stash the pixel
 * buffer in its storage, match the output resolution, **widen the texture pixel format
 * for a uint16/float32 push** (the same `_PIXEL_FORMATS` map as
 * `top_write_service._apply_pixel_format` — without it this path would silently quantize
 * a 16-bit/float frame to 8-bit), wire a self-contained callbacks DAT that copies it into
 * the texture with `copyNumpyArray`, force-cook, and print the same report. Both the
 * resolution and the format are applied fail-forward: a parameter TD rejects becomes a
 * `warnings` entry, never a throw.
 *
 * INJECTION SAFETY: this template literal contains ZERO `${}` interpolation — caller data
 * enters only through the `__META_B64__` / `__PIXELS_B64__` base64 substitutions below.
 * Keep it that way.
 *
 * The callbacks DAT written here is self-contained (it does NOT import
 * `mcp.services.top_write_service`) precisely because an older bridge does not ship
 * that module. A current bridge rewrites the DAT to its own shim on the next write,
 * so the network self-heals once the operator updates. */
const TOP_WRITE_EXEC_SCRIPT = `
import base64, json
_m = json.loads(base64.b64decode("__META_B64__").decode("utf-8"))
_data = base64.b64decode("__PIXELS_B64__")
_CB = """# tdmcp bridge — Script TOP pixel writer (POST /api/top/write, exec fallback).
import numpy


def onSetupParameters(scriptOp):
    return


def onCook(scriptOp):
    p = scriptOp.fetch("tdmcp_pixels", None, search=False)
    if not p:
        return
    a = numpy.frombuffer(p["data"], dtype=p["dtype"])
    a = a.reshape((p["height"], p["width"], p["channels"]))
    if p.get("flip"):
        a = a[::-1]
    scriptOp.copyNumpyArray(numpy.ascontiguousarray(a))
    return
"""
_w = int(_m["width"]); _h = int(_m["height"]); _c = int(_m["channels"])
_expected = _w * _h * _c * int(_m["itemsize"])
_warn = []
_report = None
_node = op(_m["path"])
_created = False
if len(_data) != _expected:
    _report = {"fatal": "top/write: pixel buffer is %d bytes but the declared geometry needs exactly %d." % (len(_data), _expected)}
elif _node is None and not _m.get("create", True):
    _report = {"fatal": "top/write: node not found: " + _m["path"]}
elif _node is None:
    _pp, _, _nm = _m["path"].rpartition("/")
    _parent = op(_pp or "/")
    if _parent is None:
        _report = {"fatal": "top/write: parent not found: " + (_pp or "/")}
    else:
        _node = _parent.create("scriptTOP", _nm)
        _created = True
if _report is None and not hasattr(_node, "copyNumpyArray"):
    _report = {"fatal": "top/write: %s is not a Script TOP (no copyNumpyArray)." % _m["path"]}
if _report is None:
    _node.store("tdmcp_pixels", {"data": _data, "dtype": _m["format"], "width": _w, "height": _h, "channels": _c, "flip": bool(_m.get("flip"))})
    try:
        _node.par.outputresolution = "custom"
        _node.par.resolutionw = _w
        _node.par.resolutionh = _h
    except Exception as _e:
        _warn.append("Could not set %s resolution: %s" % (_node.path, _e))
    _pfmt = {"uint16": "rgba16fixed", "float32": "rgba32float"}.get(_m["format"])
    if _pfmt is not None:
        try:
            _node.par.format = _pfmt
        except Exception as _e:
            _warn.append("Could not set %s pixel format to %r for a %s buffer: %s. The texture may be quantized to 8-bit." % (_node.path, _pfmt, _m["format"], _e))
    _cbname = _node.name + "_tdmcp_write"
    _cbpath = None
    try:
        _cur = str(_node.par.callbacks.eval() or "").strip()
        if _cur and _cur != _cbname:
            _warn.append("Script TOP %s already uses callbacks DAT %r — left untouched." % (_node.path, _cur))
            _cbpath = _cur
        else:
            _dat = _node.parent().op(_cbname)
            if _dat is None:
                _dat = _node.parent().create("textDAT", _cbname)
            _dat.text = _CB
            _node.par.callbacks = _cbname
            _cbpath = _dat.path
    except Exception as _e:
        _warn.append("Could not wire the callbacks DAT on %s: %s" % (_node.path, _e))
    _cooked = True
    try:
        _node.cook(force=True)
    except Exception as _e:
        _cooked = False
        _warn.append("Could not force-cook %s: %s" % (_node.path, _e))
    _report = {"path": _node.path, "width": _w, "height": _h, "channels": _c,
               "format": _m["format"], "bytes": len(_data), "origin": _m["origin"],
               "flip": bool(_m.get("flip")), "created": _created, "callbacks_path": _cbpath,
               "storage_key": "tdmcp_pixels", "cooked": _cooked,
               "max_bytes": int(_m["max_bytes"]), "warnings": _warn}
print(json.dumps(_report))
`;

/** Pixel dtypes `scriptTOP.copyNumpyArray()` accepts, and their bytes-per-sample.
 * Verbatim from docs.derivative.ca/ScriptTOP_Class: "The data type must be uint8,
 * uint16 or float32." */
const TOP_PIXEL_ITEMSIZE = { uint8: 1, uint16: 2, float32: 4 } as const;
export type TopPixelFormat = keyof typeof TOP_PIXEL_ITEMSIZE;

/** Row order of the incoming buffer. A decoded PNG/JPEG is `top_left`; TD's textures
 * are bottom-left origin, so `top_left` (the default) makes the bridge reverse the
 * rows. Reported back as `flip` — never a silent transform. */
export type TopPixelOrigin = "top_left" | "bottom_left";

/**
 * Default cap on the DECODED pixel bytes of one `writeTopPixels` call, mirroring the
 * bridge's own `TDMCP_TOP_WRITE_MAX_BYTES` default. 8 MiB: one 1080p RGBA uint8 frame
 * (1920×1080×4 = 8,294,400 B) fits; a 4K RGBA frame (33,177,600 B) does not.
 *
 * This is a **pre-flight guard only** — the bridge is the authority and enforces its
 * own (possibly reconfigured) cap. It exists so a non-colocated setup does not push
 * tens of megabytes over the network just to be rejected. Raise `maxBytes` on the call
 * if the bridge's env var was raised. An oversized frame is always REFUSED; the client
 * never downscales or truncates.
 */
export const TOP_WRITE_MAX_BYTES = 8 * 1024 * 1024;

export interface WriteTopPixelsInput {
  /** Absolute path of the destination Script TOP (e.g. `/project1/ai_tex`). */
  path: string;
  width: number;
  height: number;
  /** Raw, tightly packed pixels: `height × width × channels × sizeof(format)` bytes. */
  pixels: Uint8Array;
  /** 1–4 (`numComponents` in copyNumpyArray's `shape(h, w, numComponents)`). Default 4. */
  channels?: number;
  /** Default `uint8`. */
  format?: TopPixelFormat;
  /** Default `top_left` (a decoded image buffer). */
  origin?: TopPixelOrigin;
  /** Create the Script TOP (and its callbacks DAT) when absent. Default true. */
  create?: boolean;
  /** Pre-flight cap override; see {@link TOP_WRITE_MAX_BYTES}. */
  maxBytes?: number;
}

/** Resolve + check the geometry of a pixel push. Throws `TdApiError` on any
 * disagreement — the buffer is never padded, truncated or downscaled to fit. */
function topWriteGeometry(input: WriteTopPixelsInput): {
  channels: number;
  format: TopPixelFormat;
  itemsize: number;
  expected: number;
} {
  const format = input.format ?? "uint8";
  const itemsize = TOP_PIXEL_ITEMSIZE[format];
  if (itemsize === undefined) {
    throw new TdApiError(
      `writeTopPixels: format must be uint8, uint16 or float32 (scriptTOP.copyNumpyArray accepts no other dtype); got ${String(format)}.`,
    );
  }
  const channels = input.channels ?? 4;
  if (!Number.isInteger(channels) || channels < 1 || channels > 4) {
    throw new TdApiError(
      `writeTopPixels: channels must be 1, 2, 3 or 4; got ${String(input.channels)}.`,
    );
  }
  if (
    !Number.isInteger(input.width) ||
    !Number.isInteger(input.height) ||
    input.width <= 0 ||
    input.height <= 0
  ) {
    throw new TdApiError(
      `writeTopPixels: width and height must be positive integers; got ${input.width}x${input.height}.`,
    );
  }
  const expected = input.width * input.height * channels * itemsize;
  if (input.pixels.length !== expected) {
    throw new TdApiError(
      `writeTopPixels: pixel buffer is ${input.pixels.length} bytes but ${input.width}x${input.height} x ${channels} channels x ${format} needs exactly ${expected}. The buffer is never padded or truncated — fix the geometry or the buffer.`,
    );
  }
  const cap = input.maxBytes ?? TOP_WRITE_MAX_BYTES;
  if (expected > cap) {
    throw new TdApiError(
      `writeTopPixels: ${input.width}x${input.height} x ${channels} channels x ${format} = ${expected} bytes, over the ${cap}-byte cap. The frame is refused, not downscaled. Chunked uploads are out of scope for /api/top/write — push a smaller frame, raise TDMCP_TOP_WRITE_MAX_BYTES on the bridge (and maxBytes here), or deliver the image as a file through a Movie File In TOP.`,
    );
  }
  return { channels, format, itemsize, expected };
}

/** JSON body for `POST /api/top/write` (and the meta the exec fallback replays). */
function buildTopWriteBody(input: WriteTopPixelsInput) {
  const { channels, format } = topWriteGeometry(input);
  return {
    path: input.path,
    width: input.width,
    height: input.height,
    channels,
    format,
    origin: input.origin ?? "top_left",
    create: input.create ?? true,
    pixels_b64: Buffer.from(input.pixels).toString("base64"),
  };
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

    throwForHttpError(response, json, method, path);

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

  /** Bridge liveness/uptime/heartbeat report (`GET /api/health`). */
  getHealth() {
    return this.request("GET", "/api/health", HealthSchema);
  }

  createNode(input: CreateNodeInput) {
    return this.request("POST", "/api/nodes", NodeRefSchema, CreateNodeInputSchema.parse(input));
  }

  deleteNode(path: string, mode: "delete" | "bypass" = "delete") {
    return this.request("DELETE", `/api/nodes/${segment(path)}`, DeleteResultSchema, undefined, {
      mode,
    });
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

  sampleGrid(path: string, grid: number) {
    return this.request("GET", `/api/preview/${segment(path)}`, SampleGridSchema, undefined, {
      sample_grid: grid,
    });
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

  focusEditor(paths: string[], animate: boolean) {
    return this.request("POST", "/api/editor/focus", EditorFocusSchema, { paths, animate });
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

  // --- Raw pixel push into a Script TOP (survives TDMCP_BRIDGE_ALLOW_EXEC=0) ---
  /** Push raw pixel bytes straight into a Script TOP's texture — no file on disk.
   *
   * `POST /api/top/write`. The bridge stores the buffer on the target Script TOP and
   * force-cooks it; the TOP's managed callbacks DAT copies it into the texture with
   * `scriptTOP.copyNumpyArray()`. Pixels must be tightly packed,
   * `height × width × channels × sizeof(format)` bytes, in row order given by `origin`.
   *
   * **Wire format:** the buffer is base64-encoded into the JSON body, which costs +33%
   * on the wire (a 1080p RGBA frame: 8.29 MB → 11.06 MB). That is a deliberate,
   * honest trade — the bridge's HTTP dispatch is JSON-only and decodes the body with
   * `utf-8/ignore`, which would SILENTLY CORRUPT a raw binary body. Base64 is 7-bit
   * safe through the existing path; a binary body would need a second dispatch
   * mechanism inside TouchDesigner's WebServer DAT.
   *
   * **Payload cap:** an oversized frame is REFUSED (see {@link TOP_WRITE_MAX_BYTES}) —
   * never downscaled, never truncated. Chunked/streamed uploads are out of scope.
   *
   * **Durability:** the pixels live in the Script TOP's storage, which is session
   * state. For a durable, re-openable, cacheable asset prefer the local-file →
   * `moviefileinTOP` route; this endpoint exists for the non-colocated case (server
   * and TD on different machines) and for future per-frame streaming.
   *
   * On a 404 (an older bridge without the route) this falls back to a single
   * `/api/exec` pass that performs the same write — which of course needs
   * `TDMCP_BRIDGE_ALLOW_EXEC` enabled on that older bridge. The endpoint itself does
   * not, which is the point of promoting it.
   */
  async writeTopPixels(input: WriteTopPixelsInput): Promise<TdTopWrite> {
    const body = buildTopWriteBody(input);
    return tryEndpoint(
      () => this.request("POST", "/api/top/write", TopWriteSchema, body),
      () => this.writeTopPixelsViaExec(input, body),
    );
  }

  /** Exec-path fallback for {@link writeTopPixels} — replays the same write inside
   * TD and recovers the same report from stdout. The pixel buffer rides inside the
   * script body, so this path is as large on the wire as the endpoint's JSON. */
  private async writeTopPixelsViaExec(
    input: WriteTopPixelsInput,
    body: ReturnType<typeof buildTopWriteBody>,
  ): Promise<TdTopWrite> {
    const { itemsize } = topWriteGeometry(input);
    const meta = {
      path: body.path,
      width: body.width,
      height: body.height,
      channels: body.channels,
      format: body.format,
      itemsize,
      origin: body.origin,
      flip: body.origin === "top_left",
      create: body.create,
      max_bytes: input.maxBytes ?? TOP_WRITE_MAX_BYTES,
    };
    const metaB64 = Buffer.from(JSON.stringify(meta), "utf8").toString("base64");
    const script = TOP_WRITE_EXEC_SCRIPT.replace("__META_B64__", metaB64).replace(
      "__PIXELS_B64__",
      body.pixels_b64,
    );
    const exec = await this.executePythonScript(script, true);
    const report = parseStdoutJson(exec.stdout);
    if (report && typeof report === "object" && "fatal" in report) {
      throw new TdApiError(String((report as { fatal: unknown }).fatal));
    }
    const parsed = TopWriteSchema.safeParse(report);
    if (!parsed.success) {
      throw new TdApiError(`Unexpected writeTopPixels report shape: ${parsed.error.message}`);
    }
    return parsed.data;
  }
}
