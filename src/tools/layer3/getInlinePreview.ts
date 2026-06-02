import { z } from "zod";
import { NodeErrorSchema } from "../../td-client/validators.js";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const getInlinePreviewSchema = z.object({
  path: z.string().describe("Full path of the TOP to inspect."),
  width: z
    .number()
    .int()
    .min(16)
    .max(1024)
    .default(256)
    .describe("Thumbnail width in pixels (16–1024). Capped — this is for snapshots, not delivery."),
  height: z
    .number()
    .int()
    .min(16)
    .max(1024)
    .default(256)
    .describe("Thumbnail height in pixels (16–1024)."),
  format: z
    .enum(["jpeg", "png"])
    .default("jpeg")
    .describe(
      "Thumbnail encoding. JPEG keeps the payload small (~8–20 KB at 256²); PNG when alpha matters.",
    ),
  jpeg_quality: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(75)
    .describe("JPEG quality 1–100. Ignored when format is png."),
  parent_depth: z
    .number()
    .int()
    .min(0)
    .max(4)
    .default(1)
    .describe(
      "How many upstream hops to also check for errors. 0 = just path; 1 = path + direct inputs.",
    ),
  max_changed_params: z
    .number()
    .int()
    .min(0)
    .max(64)
    .default(12)
    .describe(
      "Top-N parameters whose value differs from the operator default, ranked alphabetic. 0 = skip.",
    ),
  include_full_params: z
    .boolean()
    .default(false)
    .describe("If true, also include the full parameters object (mirrors get_td_node_parameters)."),
});
type GetInlinePreviewArgs = z.infer<typeof getInlinePreviewSchema>;

const ChangedParamSchema = z.object({
  name: z.string(),
  value: z.unknown(),
  default: z.unknown().optional(),
});

export const getInlinePreviewOutputSchema = z.object({
  path: z.string(),
  type: z.string(),
  family: z.string().optional(),
  alive: z.boolean(),
  thumbnail: z.object({
    base64: z.string(),
    format: z.enum(["jpeg", "png"]),
    width: z.number().int(),
    height: z.number().int(),
    bytes: z.number().int(),
  }),
  cook: z.object({
    cook_time_ms: z.number().optional(),
    cook_count: z.number().int().optional(),
    resolution: z.tuple([z.number().int(), z.number().int()]).optional(),
    pixel_format: z.string().optional(),
    summary: z.string(),
  }),
  errors: z.object({
    total: z.number().int(),
    by_path: z.record(z.string(), z.array(NodeErrorSchema)),
    inspected_paths: z.array(z.string()),
  }),
  changed_params: z.array(ChangedParamSchema),
  parameters: z.record(z.string(), z.unknown()).optional(),
  warnings: z.array(z.string()).optional(),
});

interface InlineReportError {
  path: string;
  message: string;
  type?: string;
}

interface InlineReport {
  type?: string;
  family?: string;
  cook: {
    cook_time_ms?: number;
    cook_count?: number;
    width?: number;
    height?: number;
    pixel_format?: string;
  };
  errors: InlineReportError[];
  inspected_paths: string[];
  changed_params: Array<{ name: string; value: unknown; default?: unknown }>;
  parameters?: Record<string, unknown> | null;
  thumbnail?: { base64: string; format: "jpeg" | "png"; bytes: number } | null;
  warnings: string[];
  fatal?: string;
}

const INLINE_PREVIEW_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {
    "type": None, "family": None,
    "cook": {}, "errors": [], "inspected_paths": [],
    "changed_params": [], "parameters": None,
    "thumbnail": None, "warnings": [],
}
try:
    _path = _p["path"]
    _depth = int(_p.get("parent_depth", 1))
    _max_changed = int(_p.get("max_changed_params", 12))
    _include_full = bool(_p.get("include_full_params", False))
    _target_fmt = str(_p.get("target_format", "jpeg"))
    _jpeg_q = int(_p.get("jpeg_quality", 75))
    _src_b64 = _p.get("source_b64") or ""
    _src_fmt = (_p.get("source_format") or "png").lower()

    n = op(_path)
    if n is None:
        report["fatal"] = "Not found: " + str(_path)
    else:
        try:
            report["type"] = n.type
        except Exception:
            pass
        try:
            report["family"] = n.family
        except Exception:
            pass

        # Cook stats — UNVERIFIED tokens, probe gracefully
        cook = {}
        try:
            cook["cook_time_ms"] = float(n.cookTime)
        except Exception:
            pass
        # cookCount preferred, fall back to cookFrame
        for _attr in ("cookCount", "cookFrame"):
            try:
                _v = getattr(n, _attr, None)
                if _v is not None:
                    cook["cook_count"] = int(_v)
                    break
            except Exception:
                continue
        try:
            cook["width"] = int(n.width)
            cook["height"] = int(n.height)
        except Exception:
            pass
        # Pixel format — try common attribute names and parameter, otherwise omit
        _pf = None
        for _attr in ("format", "pixelFormat"):
            try:
                _v = getattr(n, _attr, None)
                if _v is not None and not callable(_v):
                    _pf = str(_v)
                    break
            except Exception:
                continue
        if _pf is None:
            try:
                _par = n.par.format
                _pf = str(_par.menuLabels[_par.menuIndex])
            except Exception:
                pass
        if _pf is not None:
            cook["pixel_format"] = _pf
        report["cook"] = cook

        # Upstream BFS up to _depth, gather errors per visited node
        visited = []
        seen = set()
        frontier = [n]
        seen.add(n.path)
        visited.append(n)
        for _ in range(max(0, _depth)):
            nxt = []
            for cur in frontier:
                try:
                    ins = list(getattr(cur, "inputs", []) or [])
                except Exception:
                    ins = []
                for u in ins:
                    if u is None:
                        continue
                    try:
                        pth = u.path
                    except Exception:
                        continue
                    if pth in seen:
                        continue
                    seen.add(pth)
                    visited.append(u)
                    nxt.append(u)
                    if len(visited) > 32:
                        report["warnings"].append("Upstream traversal capped at 32 nodes.")
                        break
                if len(visited) > 32:
                    break
            frontier = nxt
            if not frontier or len(visited) > 32:
                break

        inspected = []
        all_errors = []
        for v in visited:
            try:
                inspected.append(v.path)
            except Exception:
                continue
            try:
                errs = v.errors(recurse=False)
            except TypeError:
                try:
                    errs = v.errors()
                except Exception:
                    errs = ""
            except Exception:
                errs = ""
            if errs:
                # errors() returns a newline-separated string in TD
                for line in str(errs).splitlines():
                    s = line.strip()
                    if not s:
                        continue
                    all_errors.append({"path": v.path, "message": s, "type": "error"})
            try:
                wmsgs = v.warnings(recurse=False)
            except TypeError:
                try:
                    wmsgs = v.warnings()
                except Exception:
                    wmsgs = ""
            except Exception:
                wmsgs = ""
            if wmsgs:
                for line in str(wmsgs).splitlines():
                    s = line.strip()
                    if not s:
                        continue
                    all_errors.append({"path": v.path, "message": s, "type": "warning"})
        report["inspected_paths"] = inspected
        report["errors"] = all_errors

        # Changed-from-default parameters
        if _max_changed > 0:
            try:
                pars = list(n.pars())
            except Exception:
                pars = []
            changed = []
            for p in pars:
                try:
                    cur = p.eval()
                except Exception:
                    continue
                dflt = None
                _is_default = None
                try:
                    _is_default = bool(p.isDefault)
                except Exception:
                    _is_default = None
                try:
                    dflt = p.default
                except Exception:
                    dflt = None
                differs = False
                if _is_default is False:
                    differs = True
                elif _is_default is True:
                    differs = False
                else:
                    try:
                        differs = (cur != dflt)
                    except Exception:
                        differs = False
                if differs:
                    try:
                        cur_j = cur if isinstance(cur, (int, float, str, bool)) or cur is None else str(cur)
                    except Exception:
                        cur_j = None
                    try:
                        dflt_j = dflt if isinstance(dflt, (int, float, str, bool)) or dflt is None else str(dflt)
                    except Exception:
                        dflt_j = None
                    entry = {"name": p.name, "value": cur_j}
                    if dflt_j is not None:
                        entry["default"] = dflt_j
                    changed.append(entry)
            changed.sort(key=lambda x: x["name"])
            report["changed_params"] = changed[:_max_changed]

        if _include_full:
            full = {}
            try:
                for p in n.pars():
                    try:
                        v = p.eval()
                    except Exception:
                        continue
                    if isinstance(v, (int, float, str, bool)) or v is None:
                        full[p.name] = v
                    else:
                        full[p.name] = str(v)
            except Exception:
                pass
            report["parameters"] = full

        # Thumbnail re-encode (PNG -> JPEG) when caller asked for JPEG but bridge served PNG
        try:
            if _src_b64 and _target_fmt == "jpeg" and _src_fmt != "jpeg":
                try:
                    from PIL import Image
                    import io
                    raw = base64.b64decode(_src_b64)
                    img = Image.open(io.BytesIO(raw)).convert("RGB")
                    buf = io.BytesIO()
                    img.save(buf, format="JPEG", quality=_jpeg_q)
                    enc = base64.b64encode(buf.getvalue()).decode("ascii")
                    report["thumbnail"] = {"base64": enc, "format": "jpeg", "bytes": len(buf.getvalue())}
                except Exception:
                    report["warnings"].append("PIL unavailable; returning PNG thumbnail instead of JPEG.")
                    raw = base64.b64decode(_src_b64) if _src_b64 else b""
                    report["thumbnail"] = {"base64": _src_b64, "format": "png", "bytes": len(raw)}
            elif _src_b64:
                raw = base64.b64decode(_src_b64)
                report["thumbnail"] = {"base64": _src_b64, "format": _src_fmt if _src_fmt in ("jpeg", "png") else "png", "bytes": len(raw)}
        except Exception:
            report["warnings"].append("Thumbnail re-encode failed; keeping source bytes.")
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildGetInlinePreviewScript(payload: object): string {
  return buildPayloadScript(INLINE_PREVIEW_SCRIPT, payload);
}

interface AssembledOutput {
  path: string;
  type: string;
  family?: string;
  alive: boolean;
  thumbnail: {
    base64: string;
    format: "jpeg" | "png";
    width: number;
    height: number;
    bytes: number;
  };
  cook: {
    cook_time_ms?: number;
    cook_count?: number;
    resolution?: [number, number];
    pixel_format?: string;
    summary: string;
  };
  errors: {
    total: number;
    by_path: Record<string, InlineReportError[]>;
    inspected_paths: string[];
  };
  changed_params: Array<{ name: string; value: unknown; default?: unknown }>;
  parameters?: Record<string, unknown>;
  warnings?: string[];
}

function assemble(
  args: GetInlinePreviewArgs,
  preview: { base64: string; format: string; width: number; height: number },
  report: InlineReport,
): AssembledOutput {
  const byPath: Record<string, InlineReportError[]> = {};
  for (const e of report.errors ?? []) {
    const list = byPath[e.path] ?? [];
    list.push(e);
    byPath[e.path] = list;
  }
  const allEntries = report.errors ?? [];
  const total = allEntries.length;
  // Distinguish hard errors from warnings so a warning-only state stays "alive".
  const errorCount = allEntries.filter((e) => e.type === "error").length;
  const warningCount = total - errorCount;

  // Thumbnail: prefer the (possibly re-encoded) bytes from the python report
  const thumb = report.thumbnail;
  const thumbBase64 = thumb?.base64 ?? preview.base64;
  const thumbFormat: "jpeg" | "png" =
    thumb?.format === "jpeg" || thumb?.format === "png"
      ? thumb.format
      : preview.format === "jpeg"
        ? "jpeg"
        : "png";
  const thumbBytes = thumb?.bytes ?? Math.floor((thumbBase64.length * 3) / 4); // approximate when missing

  const cook = report.cook ?? {};
  const resolution: [number, number] | undefined =
    cook.width !== undefined && cook.height !== undefined ? [cook.width, cook.height] : undefined;

  const cookCount = cook.cook_count;
  const cookOk = cookCount !== undefined && cookCount > 0;
  // Warnings don't kill a node — only hard errors do.
  const alive = errorCount === 0 && cookOk && thumbBytes > 32;

  const typ = report.type ?? "unknown";
  const resStr = resolution ? `${resolution[0]}×${resolution[1]}` : "?×?";
  const pf = cook.pixel_format ? ` ${cook.pixel_format}` : "";
  const cookStr =
    cook.cook_time_ms !== undefined
      ? `${cook.cook_time_ms.toFixed(2)}ms × ${cookCount ?? 0} cooks`
      : `${cookCount ?? 0} cooks`;
  const errStr = `${errorCount} error${errorCount === 1 ? "" : "s"}, ${warningCount} warning${warningCount === 1 ? "" : "s"}`;
  const summary = `${args.path} (${typ}) ${resStr}${pf}, ${cookStr}, ${errStr}${alive ? "" : " — DEAD"}.`;

  const out: AssembledOutput = {
    path: args.path,
    type: typ,
    alive,
    thumbnail: {
      base64: thumbBase64,
      format: thumbFormat,
      width: preview.width,
      height: preview.height,
      bytes: thumbBytes,
    },
    cook: {
      cook_time_ms: cook.cook_time_ms,
      cook_count: cook.cook_count,
      resolution,
      pixel_format: cook.pixel_format,
      summary,
    },
    errors: {
      total,
      by_path: byPath,
      inspected_paths: report.inspected_paths ?? [],
    },
    changed_params: report.changed_params ?? [],
  };
  if (report.family) out.family = report.family;
  if (args.include_full_params && report.parameters)
    out.parameters = report.parameters as Record<string, unknown>;
  if (report.warnings && report.warnings.length > 0) out.warnings = report.warnings;
  return out;
}

export async function getInlinePreviewImpl(ctx: ToolContext, args: GetInlinePreviewArgs) {
  return guardTd(
    async () => {
      const preview = await ctx.client.getPreview(args.path, args.width, args.height);
      const script = buildGetInlinePreviewScript({
        path: args.path,
        parent_depth: args.parent_depth,
        max_changed_params: args.max_changed_params,
        include_full_params: args.include_full_params,
        target_format: args.format,
        jpeg_quality: args.jpeg_quality,
        source_b64: preview.base64,
        source_format: preview.format,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      const report = parsePythonReport<InlineReport>(exec.stdout);
      return { preview, report };
    },
    ({ preview, report }) => {
      if (report.fatal) {
        return errorResult(`get_inline_preview failed at ${args.path}: ${report.fatal}`, report);
      }
      const data = assemble(args, preview, report);
      return structuredResult(data.cook.summary, data);
    },
  );
}

export const registerGetInlinePreview: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "get_inline_preview",
    {
      title: "Inline preview (snapshot)",
      description:
        "Read-only one-shot inspection of a TOP: small base64 thumbnail (default 256² JPEG) + parent error sweep (BFS up `parent_depth` hops) + top-N changed-from-default parameters + cook stats. One call instead of chaining get_preview / get_td_node_errors / get_td_node_parameters when you just want to know 'is this op alive and healthy?'. Use get_preview/render_output for delivery-grade frames; this thumbnail is intentionally tiny + lossy.",
      inputSchema: getInlinePreviewSchema.shape,
      outputSchema: getInlinePreviewOutputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    (args) => getInlinePreviewImpl(ctx, args),
  );
};
