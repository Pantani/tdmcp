import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

// A minimal GeoJSON subset: Point / LineString / Polygon features. We only read
// geometry coordinates (lng, lat pairs) and an optional numeric `height` property.
const GeoJsonSchema = z
  .object({
    type: z.string().describe("GeoJSON root type — 'FeatureCollection' or 'Feature'."),
    features: z
      .array(
        z.object({
          type: z.string().optional(),
          properties: z.record(z.string(), z.unknown()).nullable().optional(),
          geometry: z
            .object({
              type: z.enum(["Point", "LineString", "Polygon", "MultiPolygon", "MultiLineString"]),
              // Coordinates are deliberately loosely typed — nested arrays vary by geometry type.
              coordinates: z.unknown(),
            })
            .nullable(),
        }),
      )
      .optional(),
    geometry: z.object({ type: z.string(), coordinates: z.unknown() }).nullable().optional(),
  })
  .describe(
    "A GeoJSON FeatureCollection (or single Feature). Only geometry coordinates + an optional numeric 'height' property are read.",
  );

export const createGeoVisualizationSchema = z.object({
  name: z.string().default("geo_viz").describe("Base name for the container COMP."),
  parent_path: z
    .string()
    .default("/project1")
    .describe("COMP to create the geo visualization container in (default '/project1')."),
  geojson: GeoJsonSchema,
  scale: z.coerce
    .number()
    .min(0.001)
    .max(1000)
    .default(100)
    .describe(
      "World-units per projected unit. The projection is normalized to [-1,1] then scaled.",
    ),
  extrude: z
    .boolean()
    .default(true)
    .describe(
      "Extrude polygon/line features into 3D 'buildings' using each feature's 'height' property (default height when missing).",
    ),
  default_height: z.coerce
    .number()
    .min(0)
    .max(1000)
    .default(0.1)
    .describe("Height (world units) for extruded features lacking a numeric 'height' property."),
});

export type CreateGeoVisualizationArgs = z.infer<typeof createGeoVisualizationSchema>;

interface ProjectedFeature {
  kind: "point" | "line";
  points: Array<[number, number]>;
  height: number;
}

interface GeoVizReport {
  container: string;
  script_sop: string;
  out: string;
  render: string;
  feature_count: number;
  point_features: number;
  line_features: number;
  errors?: string[];
  warnings: string[];
  fatal?: string;
}

// Web-Mercator-ish equirectangular projection then normalization to [-1,1]. For city-scale
// visualization the simple equirectangular projection (lng, lat*cos-corrected) is plenty and
// keeps the code dependency-free.
export function projectFeatures(
  geojson: unknown,
  defaultHeight: number,
): { features: ProjectedFeature[]; warnings: string[] } {
  const warnings: string[] = [];
  const rawFeatures: Array<{ geometry: unknown; properties: unknown }> = [];
  const g = geojson as {
    type?: string;
    features?: unknown;
    geometry?: unknown;
    properties?: unknown;
  };
  if (g.type === "FeatureCollection" && Array.isArray(g.features)) {
    for (const f of g.features as Array<{ geometry?: unknown; properties?: unknown }>) {
      rawFeatures.push({ geometry: f.geometry, properties: f.properties });
    }
  } else if (g.geometry) {
    rawFeatures.push({ geometry: g.geometry, properties: g.properties });
  } else {
    warnings.push("GeoJSON has no FeatureCollection.features and no top-level geometry.");
  }

  // Collect all lng/lat pairs to compute the bounding box for normalization.
  const collected: Array<{
    kind: "point" | "line";
    coords: Array<[number, number]>;
    height: number;
  }> = [];
  for (const rf of rawFeatures) {
    const geom = rf.geometry as { type?: string; coordinates?: unknown } | null;
    if (!geom || !geom.type) continue;
    const props = (rf.properties ?? {}) as Record<string, unknown>;
    const heightRaw = props.height ?? props.render_height;
    const height =
      typeof heightRaw === "number" && Number.isFinite(heightRaw) ? heightRaw : defaultHeight;
    const rings = flattenToRings(geom.type, geom.coordinates);
    if (rings.length === 0) continue;
    if (geom.type === "Point") {
      const p = rings[0]?.[0];
      if (p) collected.push({ kind: "point", coords: [p], height });
    } else {
      for (const ring of rings) {
        if (ring.length >= 2) collected.push({ kind: "line", coords: ring, height });
      }
    }
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const c of collected) {
    for (const [lng, lat] of c.coords) {
      const y = mercatorY(lat);
      minX = Math.min(minX, lng);
      maxX = Math.max(maxX, lng);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  const span = Math.max(spanX, spanY);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  const features: ProjectedFeature[] = collected.map((c) => ({
    kind: c.kind,
    height: c.height,
    points: c.coords.map(([lng, lat]) => {
      const y = mercatorY(lat);
      return [((lng - cx) / span) * 2, ((y - cy) / span) * 2] as [number, number];
    }),
  }));
  if (features.length === 0) warnings.push("No usable Point/LineString/Polygon geometry found.");
  return { features, warnings };
}

function mercatorY(lat: number): number {
  const clamped = Math.max(-85, Math.min(85, lat));
  const rad = (clamped * Math.PI) / 180;
  return Math.log(Math.tan(Math.PI / 4 + rad / 2));
}

// Reduce every supported geometry type to an array of coordinate rings ([[lng,lat],...]).
function flattenToRings(type: string, coords: unknown): Array<Array<[number, number]>> {
  const asPair = (v: unknown): [number, number] | null => {
    if (Array.isArray(v) && typeof v[0] === "number" && typeof v[1] === "number") {
      return [v[0], v[1]];
    }
    return null;
  };
  if (type === "Point") {
    const p = asPair(coords);
    return p ? [[p]] : [];
  }
  if (type === "LineString") {
    const ring = (coords as unknown[]).map(asPair).filter((p): p is [number, number] => p !== null);
    return ring.length ? [ring] : [];
  }
  if (type === "Polygon" || type === "MultiLineString") {
    return (coords as unknown[][])
      .map((ring) => ring.map(asPair).filter((p): p is [number, number] => p !== null))
      .filter((r) => r.length > 0);
  }
  if (type === "MultiPolygon") {
    const out: Array<Array<[number, number]>> = [];
    for (const poly of coords as unknown[][][]) {
      for (const ring of poly) {
        const r = ring.map(asPair).filter((p): p is [number, number] => p !== null);
        if (r.length) out.push(r);
      }
    }
    return out;
  }
  return [];
}

// One Python pass. Builds a Script SOP that constructs the projected city geometry from the
// pre-projected feature data (points → point cloud; lines/polygons → poly lines, optionally
// extruded into ribbons using each feature's height), then wraps it in a Geometry COMP under
// a camera+light Render TOP. Fail-forward.
const GEO_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"container": "", "script_sop": "", "out": "", "render": "", "feature_count": 0, "point_features": 0, "line_features": 0, "errors": [], "warnings": list(_p.get("warnings", []))}

def _try(label, fn):
    try:
        return fn()
    except Exception as _e:
        report["warnings"].append(label + ": " + str(_e))
        return None

# Script SOP cook code lives in a companion callbacks DAT, resolved via the op's 'callbacks'
# par (with a name-based fallback). Set THAT DAT's text, never the op's.
def _set_script_cook(_op, _text):
    _cb = None
    try:
        _cb = _op.par.callbacks.eval()
    except Exception:
        _cb = None
    if _cb is None:
        try:
            _cb = _op.parent().op(_op.name + '_callbacks')
        except Exception:
            _cb = None
    if _cb is None:
        _cb = _try("callbacks dat", lambda: _op.parent().create(textDAT, _op.name + '_callbacks'))
        if _cb is not None:
            _try("callbacks par", lambda: setattr(_op.par, "callbacks", _cb.name))
    if _cb is None:
        report["warnings"].append("Could not resolve callbacks DAT for " + _op.path)
        return
    _try("callbacks text", lambda: setattr(_cb, "text", _text))

_SOP_COOK = '''# tdmcp geo_visualization — builds projected city geometry from stored feature data.
def onCook(scriptOp):
    scriptOp.clear()
    p = scriptOp.parent()
    feats = p.fetch('tdmcp_geo', [])
    scale = p.fetch('tdmcp_geo_scale', 1.0)
    extrude = p.fetch('tdmcp_geo_extrude', True)
    for f in feats:
        pts = f.get('points', [])
        h = float(f.get('height', 0.0)) * scale if extrude else 0.0
        if f.get('kind') == 'point':
            if pts:
                x, z = pts[0][0] * scale, pts[0][1] * scale
                v = scriptOp.appendPoint()
                v.point.x = x; v.point.y = 0.0; v.point.z = z
            continue
        # line / polygon ring -> a polyline; optionally a second raised ring for a ribbon wall.
        prim = scriptOp.appendPoly(len(pts), closed=False, addPoints=True)
        for i, (x, z) in enumerate(pts):
            prim[i].point.x = x * scale; prim[i].point.y = 0.0; prim[i].point.z = z * scale
        if extrude and h > 0 and len(pts) >= 2:
            top = scriptOp.appendPoly(len(pts), closed=False, addPoints=True)
            for i, (x, z) in enumerate(pts):
                top[i].point.x = x * scale; top[i].point.y = h; top[i].point.z = z * scale
    return
'''

try:
    _parent = op(_p["parent_path"])
    if _parent is None:
        report["fatal"] = "Parent COMP not found: " + str(_p["parent_path"])
    else:
        _c = _parent.create(baseCOMP, _p["name"])
        report["container"] = _c.path
        _feats = _p["features"]
        report["feature_count"] = len(_feats)
        report["point_features"] = sum(1 for f in _feats if f.get("kind") == "point")
        report["line_features"] = sum(1 for f in _feats if f.get("kind") == "line")

        # Stash the projected feature data on the container for the Script SOP to read.
        _try("store feats", lambda: _c.store("tdmcp_geo", _feats))
        _try("store scale", lambda: _c.store("tdmcp_geo_scale", float(_p["scale"])))
        _try("store extrude", lambda: _c.store("tdmcp_geo_extrude", bool(_p["extrude"])))

        _sop = _try("script sop", lambda: _c.create(scriptSOP, "city"))
        if _sop is not None:
            _set_script_cook(_sop, _SOP_COOK)
            report["script_sop"] = _sop.path
        _null = _try("null sop", lambda: _c.create(nullSOP, "city_out"))
        if _null is not None and _sop is not None:
            _try("null connect", lambda: _null.inputConnectors[0].connect(_sop))
            report["out"] = _null.path

        # Wrap in a Geometry COMP + render so it previews immediately.
        _geo = _try("geo comp", lambda: _c.create(geometryCOMP, "geo"))
        if _geo is not None and _null is not None:
            _in = _try("geo instance in", lambda: _geo.create(inSOP, "in1"))
            # Point the Geometry COMP at the city null via a Select SOP inside it.
            _sel = _try("geo select sop", lambda: _geo.create(selectSOP, "select1"))
            if _sel is not None:
                _try("geo select par", lambda: setattr(_sel.par, "sop", _null.path))
                _try("geo render par", lambda: setattr(_sel.par, "render", True) if hasattr(_sel.par, "render") else None)
        _cam = _try("cam", lambda: _c.create(cameraCOMP, "cam"))
        if _cam is not None:
            _try("cam pos", lambda: (setattr(_cam.par, "ty", float(_p["scale"]) * 0.8), setattr(_cam.par, "tz", float(_p["scale"]) * 1.2)))
        _light = _try("light", lambda: _c.create(lightCOMP, "light"))
        _render = _try("render", lambda: _c.create(renderTOP, "render"))
        if _render is not None:
            _try("render res", lambda: (setattr(_render.par, "resolutionw", 1280), setattr(_render.par, "resolutionh", 720)))
            if _cam is not None:
                _try("render cam", lambda: setattr(_render.par, "camera", _cam.name))
            if _light is not None:
                _try("render light", lambda: setattr(_render.par, "lights", _light.name))
            if _geo is not None:
                _try("render geos", lambda: setattr(_render.par, "geometry", _geo.name) if hasattr(_render.par, "geometry") else None)
            report["render"] = _render.path
        try:
            if _sop is not None:
                report["errors"] = [str(e) for e in _sop.errors()][:3]
        except Exception:
            pass
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildGeoVisualizationScript(payload: object): string {
  return buildPayloadScript(GEO_SCRIPT, payload);
}

export async function createGeoVisualizationImpl(
  ctx: ToolContext,
  args: CreateGeoVisualizationArgs,
) {
  const { features, warnings } = projectFeatures(args.geojson, args.default_height);
  return guardTd(
    async () => {
      const script = buildGeoVisualizationScript({
        parent_path: args.parent_path,
        name: args.name,
        scale: args.scale,
        extrude: args.extrude,
        features,
        warnings,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<GeoVizReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`Geo visualization build failed: ${report.fatal}`, report);
      }
      const warnNote = report.warnings.length > 0 ? `, ${report.warnings.length} warning(s)` : "";
      const summary = `Built a geo visualization from ${report.feature_count} feature(s) (${report.point_features} point, ${report.line_features} line/polygon) → ${report.out || "city_out"} previewed via ${report.render || "render"}${warnNote}. Map data © OpenStreetMap contributors, ODbL — attribute if you use OSM-derived data.`;
      return jsonResult(summary, report);
    },
  );
}

export const registerCreateGeoVisualization: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_geo_visualization",
    {
      title: "Create GeoJSON / OSM city visualization",
      description:
        "Turn GeoJSON (e.g. OpenStreetMap-derived) into a 3D city visualization. Reads Point / LineString / Polygon / Multi* features, projects lat/long via a Mercator projection normalized to a unit box, and builds a Script SOP that lays out point clouds for points and polylines for streets/building footprints — optionally extruded into 3D ribbon 'walls' using each feature's numeric 'height' property — all wrapped in a Geometry COMP under a camera+light Render TOP for instant preview. NOTE: OpenStreetMap map data is © OpenStreetMap contributors and licensed under the Open Database License (ODbL); you must attribute it when visualizing OSM-derived data.",
      inputSchema: createGeoVisualizationSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createGeoVisualizationImpl(ctx, args),
  );
};
