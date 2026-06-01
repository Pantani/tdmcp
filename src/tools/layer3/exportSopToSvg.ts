import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { friendlyTdError } from "../../td-client/types.js";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

/**
 * `export_sop_to_svg` — read a SOP's point/primitive geometry via the bridge and
 * emit an SVG document of its polylines (each primitive becomes one `<polyline>`).
 * Project x/y, drop z; SVG viewBox is auto-fit. Pen-plotter / laser / print
 * deliverable. Write to disk when `output_path` is supplied; always return the
 * SVG string in the report.
 */

// Accepts: #rgb / #rgba / #rrggbb / #rrggbbaa hex, rgb(...) / rgba(...) /
// hsl(...) / hsla(...) functional notation, a CSS named colour (letters only),
// or the keywords 'none' / 'transparent' / 'currentColor'. Rejects anything
// containing quotes, angle brackets, semicolons, or whitespace outside the
// parenthesised functional forms — so a value can never break out of an SVG
// attribute and inject markup or event handlers.
const cssColorSchema = z
  .string()
  .regex(
    /^(?:#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|(?:rgb|rgba|hsl|hsla)\([0-9eE+\-.,%\s/]+\)|[a-zA-Z]+)$/,
    "Must be a CSS hex (#rgb, #rgba, #rrggbb, or #rrggbbaa), rgb()/rgba()/hsl()/hsla(), or a named colour keyword.",
  );

export const exportSopToSvgSchema = z.object({
  source_path: z.string().describe("SOP path to export (e.g. '/project1/geo1/circle1')."),
  output_path: z
    .string()
    .optional()
    .describe("Absolute filesystem path to write the SVG to. Omit to only return it inline."),
  stroke_color: cssColorSchema
    .default("#000000")
    .describe(
      "CSS color for polyline strokes (default black). Accepts hex, rgb()/rgba()/hsl()/hsla(), or a named colour; anything that could break out of an SVG attribute is rejected.",
    ),
  stroke_width: z.coerce.number().positive().default(1).describe("Stroke width in SVG units."),
  fill_color: cssColorSchema
    .default("none")
    .describe(
      "CSS color for fills (default 'none' — outlines only, plotter-style). Same allowlist as stroke_color.",
    ),
  scale: z.coerce
    .number()
    .positive()
    .default(100)
    .describe("Scale factor applied to SOP units (TD SOPs are typically [-1..1])."),
  flip_y: z
    .boolean()
    .default(true)
    .describe("Flip Y so the SVG matches TD's viewport orientation."),
});
export type ExportSopToSvgArgs = z.infer<typeof exportSopToSvgSchema>;

interface SopExportReport {
  source_path: string;
  point_count?: number;
  prim_count?: number;
  polylines?: number[][][];
  fatal?: string;
  warnings?: string[];
}

const READ_SOP_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"source_path": _p["source_path"], "polylines": [], "warnings": []}
try:
    _s = op(_p["source_path"])
    if _s is None:
        report["fatal"] = "SOP not found: " + _p["source_path"]
    elif not _s.isSOP:
        report["fatal"] = _p["source_path"] + " is not a SOP"
    else:
        report["point_count"] = int(getattr(_s, "numPoints", 0))
        report["prim_count"] = int(getattr(_s, "numPrims", 0))
        try:
            _prims = list(_s.prims)
        except Exception:
            _prims = []
        for _pr in _prims:
            poly = []
            try:
                # TD Prim (e.g. Poly) is iterable over its vertices; each vertex
                # exposes a .point with .x/.y/.z. Fall back to .points if present.
                try:
                    _verts = list(_pr)
                except TypeError:
                    _verts = list(getattr(_pr, "points", []) or [])
                for _v in _verts:
                    _pt = getattr(_v, "point", _v)
                    poly.append([float(_pt.x), float(_pt.y), float(_pt.z)])
            except Exception:
                continue
            if len(poly) >= 2:
                report["polylines"].append(poly)
        if not report["polylines"]:
            # Fallback: emit all points as one polyline (point clouds).
            try:
                pts = [[float(p.x), float(p.y), float(p.z)] for p in _s.points]
                if len(pts) >= 2:
                    report["polylines"].append(pts)
                    report["warnings"].append("No primitive polylines; emitted all points as a single polyline.")
            except Exception:
                pass
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

// Escape a string for safe interpolation into a double-quoted XML/SVG attribute
// value. Defence-in-depth alongside the schema allowlist — even if the regex
// ever broadens, attribute breakouts (`"`, `<`, `>`, `&`, `'`) get neutralised
// here before they reach the SVG document.
function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildSvg(report: SopExportReport, args: ExportSopToSvgArgs): string {
  const polys = report.polylines ?? [];
  // Compute bounds in projected x/y, applying scale + optional flip_y.
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  const projected: number[][][] = polys.map((poly) =>
    poly.map((pt) => {
      const x = (pt[0] ?? 0) * args.scale;
      const y = (args.flip_y ? -(pt[1] ?? 0) : (pt[1] ?? 0)) * args.scale;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      return [x, y];
    }),
  );
  if (!Number.isFinite(minX)) {
    minX = 0;
    minY = 0;
    maxX = 100;
    maxY = 100;
  }
  const pad = 8;
  const w = Math.max(1, maxX - minX) + pad * 2;
  const h = Math.max(1, maxY - minY) + pad * 2;
  const tx = -minX + pad;
  const ty = -minY + pad;
  const fillAttr = escapeXmlAttr(args.fill_color);
  const strokeAttr = escapeXmlAttr(args.stroke_color);
  const lines = projected
    .map((poly) => {
      const points = poly.map((p) => `${(p[0] ?? 0) + tx},${(p[1] ?? 0) + ty}`).join(" ");
      return `  <polyline points="${points}" fill="${fillAttr}" stroke="${strokeAttr}" stroke-width="${args.stroke_width}" />`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w.toFixed(3)} ${h.toFixed(3)}" width="${w.toFixed(3)}" height="${h.toFixed(3)}">
${lines}
</svg>
`;
}

export async function exportSopToSvgImpl(ctx: ToolContext, args: ExportSopToSvgArgs) {
  try {
    const exec = await ctx.client.executePythonScript(
      buildPayloadScript(READ_SOP_SCRIPT, { source_path: args.source_path }),
      true,
    );
    const report = parsePythonReport<SopExportReport>(exec.stdout);
    if (report.fatal) {
      return errorResult(`Could not export SOP: ${report.fatal}`, {
        source_path: args.source_path,
      });
    }
    const svg = buildSvg(report, args);
    let written: string | null = null;
    if (args.output_path) {
      const abs = resolve(args.output_path);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, svg, "utf8");
      written = abs;
    }
    return jsonResult(
      `Exported ${report.polylines?.length ?? 0} polyline(s) from ${report.source_path}${written ? ` to ${written}` : ""}.`,
      {
        source_path: report.source_path,
        point_count: report.point_count ?? 0,
        prim_count: report.prim_count ?? 0,
        polyline_count: report.polylines?.length ?? 0,
        output_path: written,
        svg,
        warnings: report.warnings ?? [],
      },
    );
  } catch (err) {
    return errorResult(friendlyTdError(err));
  }
}

export const registerExportSopToSvg: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "export_sop_to_svg",
    {
      title: "Export a SOP's geometry as SVG",
      description:
        "Walk a SOP's primitives via the bridge and emit an SVG document of polylines (each primitive becomes one `<polyline>`). Projects to x/y (drops z), auto-fits viewBox, supports stroke/fill/scale/flip_y. Writes to disk when `output_path` is supplied and always returns the SVG string in the report. Pen-plotter / laser / print deliverable.",
      inputSchema: exportSopToSvgSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => exportSopToSvgImpl(ctx, args),
  );
};
