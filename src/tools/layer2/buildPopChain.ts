import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

// ---------------------------------------------------------------------------
// Curated POP-kind enum (77 chainable kinds, sourced from src/knowledge/data/operators)
// ---------------------------------------------------------------------------

export const POP_KINDS = [
  // Generators
  "point_generator_pop",
  "grid_pop",
  "sphere_pop",
  "box_pop",
  "torus_pop",
  "tube_pop",
  "circle_pop",
  "rectangle_pop",
  "line_pop",
  "curve_pop",
  "point_file_in_pop",
  "file_in_pop",
  "import_select_pop",
  "in_pop",
  // Single-input transformers
  "noise_pop",
  "transform_pop",
  "attribute_pop",
  "attribute_combine_pop",
  "attribute_convert_pop",
  "math_pop",
  "math_combine_pop",
  "math_mix_pop",
  "rerange_pop",
  "normalize_pop",
  "trig_pop",
  "pattern_pop",
  "phaser_pop",
  "random_pop",
  "quantize_pop",
  "delete_pop",
  "group_pop",
  "sort_pop",
  "limit_pop",
  "convert_pop",
  "dimension_pop",
  "point_pop",
  "primitive_pop",
  "polygonize_pop",
  "extrude_pop",
  "revolve_pop",
  "subdivide_pop",
  "twist_pop",
  "facet_pop",
  "skin_pop",
  "skin_deform_pop",
  "sprinkle_pop",
  "normal_pop",
  "neighbor_pop",
  "topology_pop",
  "trail_pop",
  "force_pop",
  "particle_pop",
  "cache_pop",
  "cache_blend_pop",
  "cache_select_pop",
  "field_pop",
  "select_pop",
  "texture_map_pop",
  "analyze_pop",
  "histogram_pop",
  "ray_pop",
  "projection_pop",
  "line_break_pop",
  "line_divide_pop",
  "line_metrics_pop",
  "line_smooth_pop",
  "accumulate_pop",
  // Multi-input
  "merge_pop",
  "copy_pop",
  "feedback_pop",
  "proximity_pop",
  "switch_pop",
  "blend_pop",
  // Lookup family
  "lookup_attribute_pop",
  "lookup_channel_pop",
  "lookup_texture_pop",
  // Chain terminator
  "null_pop",
] as const;

export type PopKind = (typeof POP_KINDS)[number];

// ---------------------------------------------------------------------------
// Per-kind defaults + optype map. Defensive: unknown par names → warnings.
// POPs are Experimental in this TD build; KB par lists may be noisy.
// ---------------------------------------------------------------------------

type KindEntry = {
  optype: string;
  description: string;
  defaults: Record<string, string | number | boolean>;
};

export const POP_KIND_DEFAULTS: Record<PopKind, KindEntry> = {
  // Generators
  point_generator_pop: {
    optype: "pointgeneratorPOP",
    description: "Scatter N points",
    defaults: { numpoints: 10000, distribution: "random" },
  },
  grid_pop: { optype: "gridPOP", description: "Rect lattice", defaults: { rows: 32, cols: 32 } },
  sphere_pop: {
    optype: "spherePOP",
    description: "Spherical shell",
    defaults: { rows: 32, cols: 32 },
  },
  box_pop: { optype: "boxPOP", description: "Box surface", defaults: {} },
  torus_pop: { optype: "torusPOP", description: "Torus surface", defaults: {} },
  tube_pop: { optype: "tubePOP", description: "Tube/cylinder", defaults: {} },
  circle_pop: { optype: "circlePOP", description: "Circle ring", defaults: {} },
  rectangle_pop: { optype: "rectanglePOP", description: "Rect outline", defaults: {} },
  line_pop: { optype: "linePOP", description: "Line segment", defaults: {} },
  curve_pop: { optype: "curvePOP", description: "Bezier/NURBS curve", defaults: {} },
  point_file_in_pop: {
    optype: "pointfileinPOP",
    description: "Load .ply/.bgeo",
    defaults: {},
  },
  file_in_pop: {
    optype: "fileinPOP",
    description: "Load generic point file",
    defaults: {},
  },
  import_select_pop: {
    optype: "importselectPOP",
    description: "Import-from-DAT path",
    defaults: {},
  },
  in_pop: { optype: "inPOP", description: "Subnet input port", defaults: {} },
  // Single-input transformers
  noise_pop: {
    optype: "noisePOP",
    description: "Per-point displacement",
    defaults: { amp: 0.3, period: 1.0 },
  },
  transform_pop: {
    optype: "transformPOP",
    description: "Translate/rotate/scale points",
    defaults: {},
  },
  attribute_pop: { optype: "attributePOP", description: "Add/modify attribute", defaults: {} },
  attribute_combine_pop: {
    optype: "attributecombinePOP",
    description: "Combine attrs",
    defaults: {},
  },
  attribute_convert_pop: {
    optype: "attributeconvertPOP",
    description: "Convert attr type",
    defaults: {},
  },
  math_pop: { optype: "mathPOP", description: "Per-point math", defaults: {} },
  math_combine_pop: {
    optype: "mathcombinePOP",
    description: "Combine two attrs by math",
    defaults: {},
  },
  math_mix_pop: { optype: "mathmixPOP", description: "Mix two attrs", defaults: {} },
  rerange_pop: { optype: "rerangePOP", description: "Remap attribute range", defaults: {} },
  normalize_pop: {
    optype: "normalizePOP",
    description: "Normalize vector attr",
    defaults: {},
  },
  trig_pop: { optype: "trigPOP", description: "Per-point sin/cos/tan", defaults: {} },
  pattern_pop: {
    optype: "patternPOP",
    description: "Procedural pattern over attr",
    defaults: {},
  },
  phaser_pop: { optype: "phaserPOP", description: "Per-point time phase", defaults: {} },
  random_pop: { optype: "randomPOP", description: "Random per-point", defaults: {} },
  quantize_pop: { optype: "quantizePOP", description: "Snap attr to step", defaults: {} },
  delete_pop: { optype: "deletePOP", description: "Filter points", defaults: {} },
  group_pop: { optype: "groupPOP", description: "Group points by attr", defaults: {} },
  sort_pop: { optype: "sortPOP", description: "Sort points", defaults: {} },
  limit_pop: { optype: "limitPOP", description: "Limit/clamp", defaults: {} },
  convert_pop: { optype: "convertPOP", description: "Convert primitive type", defaults: {} },
  dimension_pop: {
    optype: "dimensionPOP",
    description: "Per-point bbox sizes",
    defaults: {},
  },
  point_pop: { optype: "pointPOP", description: "Per-point attr edits", defaults: {} },
  primitive_pop: { optype: "primitivePOP", description: "Per-primitive edits", defaults: {} },
  polygonize_pop: {
    optype: "polygonizePOP",
    description: "Build polys from curves",
    defaults: {},
  },
  extrude_pop: {
    optype: "extrudePOP",
    description: "Extrude curves to surfaces",
    defaults: {},
  },
  revolve_pop: { optype: "revolvePOP", description: "Revolve curves", defaults: {} },
  subdivide_pop: { optype: "subdividePOP", description: "Subdivide mesh", defaults: { depth: 1 } },
  twist_pop: { optype: "twistPOP", description: "Twist deform", defaults: {} },
  facet_pop: { optype: "facetPOP", description: "Recompute normals/uv", defaults: {} },
  skin_pop: { optype: "skinPOP", description: "Skin curves to surface", defaults: {} },
  skin_deform_pop: {
    optype: "skinDeformPOP",
    description: "Skinning deformer",
    defaults: {},
  },
  sprinkle_pop: {
    optype: "sprinklePOP",
    description: "Scatter onto surface",
    defaults: {},
  },
  normal_pop: { optype: "normalPOP", description: "Compute normals", defaults: {} },
  neighbor_pop: { optype: "neighborPOP", description: "Neighbour graph", defaults: {} },
  topology_pop: { optype: "topologyPOP", description: "Edit topology", defaults: {} },
  trail_pop: {
    optype: "trailPOP",
    description: "Trail history per point",
    defaults: {},
  },
  force_pop: {
    optype: "forcePOP",
    description: "Apply force to particles",
    defaults: {},
  },
  particle_pop: { optype: "particlePOP", description: "Particle simulator", defaults: {} },
  cache_pop: { optype: "cachePOP", description: "Frame cache", defaults: {} },
  cache_blend_pop: {
    optype: "cacheblendPOP",
    description: "Blend cached frames",
    defaults: {},
  },
  cache_select_pop: {
    optype: "cacheselectPOP",
    description: "Pick cached frame",
    defaults: {},
  },
  field_pop: { optype: "fieldPOP", description: "Shape-field weight attr", defaults: {} },
  select_pop: {
    optype: "selectPOP",
    description: "Path-reference another POP",
    defaults: {},
  },
  texture_map_pop: {
    optype: "texturemapPOP",
    description: "Sample TOP into attr",
    defaults: {},
  },
  analyze_pop: {
    optype: "analyzePOP",
    description: "Statistics over attr",
    defaults: {},
  },
  histogram_pop: {
    optype: "histogramPOP",
    description: "Per-attr histogram",
    defaults: {},
  },
  ray_pop: { optype: "rayPOP", description: "Project along ray", defaults: {} },
  projection_pop: {
    optype: "projectionPOP",
    description: "Project onto surface",
    defaults: {},
  },
  line_break_pop: {
    optype: "linebreakPOP",
    description: "Split lines at gaps",
    defaults: {},
  },
  line_divide_pop: {
    optype: "linedividePOP",
    description: "Subdivide lines",
    defaults: {},
  },
  line_metrics_pop: {
    optype: "linemetricsPOP",
    description: "Per-line lengths/etc",
    defaults: {},
  },
  line_smooth_pop: { optype: "linesmoothPOP", description: "Smooth lines", defaults: {} },
  accumulate_pop: {
    optype: "accumulatePOP",
    description: "Accumulate per-frame",
    defaults: {},
  },
  // Multi-input
  merge_pop: { optype: "mergePOP", description: "Merge prev + extras", defaults: {} },
  copy_pop: {
    optype: "copyPOP",
    description: "Copy template onto pts",
    defaults: {},
  },
  feedback_pop: {
    optype: "feedbackPOP",
    description: "Frame-delayed loop",
    defaults: {},
  },
  proximity_pop: {
    optype: "proximityPOP",
    description: "Connect near points",
    defaults: {},
  },
  switch_pop: {
    optype: "switchPOP",
    description: "Select 1-of-N input",
    defaults: { index: 0 },
  },
  blend_pop: { optype: "blendPOP", description: "Blend two POPs", defaults: {} },
  // Lookup family
  lookup_attribute_pop: {
    optype: "lookupattributePOP",
    description: "Index attr→attr lookup",
    defaults: {},
  },
  lookup_channel_pop: {
    optype: "lookupchannelPOP",
    description: "Index attr→CHOP lookup",
    defaults: {},
  },
  lookup_texture_pop: {
    optype: "lookuptexturePOP",
    description: "Index attr→TOP lookup",
    defaults: {},
  },
  // Chain terminator
  null_pop: {
    optype: "nullPOP",
    description: "Stable output handle (recommended terminator)",
    defaults: {},
  },
};

// Compact per-kind map shipped in the Python payload (description stripped — TS only).
type CompactEntry = { optype: string; defaults: Record<string, string | number | boolean> };
type DefaultsMap = Record<string, CompactEntry>;

function buildDefaultsMap(): DefaultsMap {
  const map: DefaultsMap = {};
  for (const kind of POP_KINDS) {
    const entry = POP_KIND_DEFAULTS[kind];
    map[kind] = { optype: entry.optype, defaults: entry.defaults };
  }
  return map;
}

const DEFAULTS_MAP = buildDefaultsMap();

// ---------------------------------------------------------------------------
// Zod schema
// ---------------------------------------------------------------------------

const chainEntrySchema = z.object({
  type: z.enum(POP_KINDS).describe("Curated chainable POP kind. 77 entries — see POP_KINDS."),
  name: z.string().optional().describe("Explicit node name. Default '<name>_<i>_<typeStem>'."),
  params: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional()
    .describe(
      "Par overlay applied after kind defaults. String value matching an earlier op's name resolves to that op's path.",
    ),
  extra_inputs: z
    .array(z.string())
    .optional()
    .describe(
      "Additional input paths for multi-input kinds (mergePOP, copyPOP, feedbackPOP, proximityPOP, switchPOP, blendPOP). Wired into input 1, 2, … in order.",
    ),
});

export const buildPopChainSchema = z.object({
  parent: z
    .string()
    .default("/project1")
    .describe("Parent COMP path (default '/project1'). Same semantic as build_chop_chain."),
  name: z.string().describe("Base name; used as prefix for auto-named ops and as the chain id."),
  chain: z
    .array(chainEntrySchema)
    .min(1)
    .describe(
      "Ordered POP chain. chain[i] is wired output 0 → input 0 of chain[i+1]; extra_inputs of chain[i] are wired into input 1, 2, …",
    ),
});

export type BuildPopChainArgs = z.infer<typeof buildPopChainSchema>;

// ---------------------------------------------------------------------------
// Python bridge script (one pass — create, default-apply, param-overlay, wire)
// ---------------------------------------------------------------------------

const UNVERIFIED_NOTE =
  "POPs are Experimental — par names not verified against a live TD. Per-op param/connect failures become warnings.";

const POP_CHAIN_SCRIPT = `
import json, base64, traceback
import td
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"container": _p["parent"], "created": [], "connections": [],
          "output_path": None, "warnings": [], "unverified": _p["unverified_note"]}

_parent = op(_p["parent"])
try:
    if _parent is None:
        report["fatal"] = "Parent not found: " + _p["parent"]
    else:
        report["container"] = _parent.path
        _created = []
        _name_to_path = {}
        _defaults_map = _p["defaults_map"]

        for _i, _spec in enumerate(_p["chain"]):
            _kind = _spec["type"]
            _kd = _defaults_map[_kind]
            _typ = _kd["optype"]
            _stem = _typ[:-3] if _typ.lower().endswith("pop") else _typ
            _nm = _spec.get("name") or ("%s_%d_%s" % (_p["name"], _i, _stem))
            _node = None
            try:
                _cls = getattr(td, _typ)
                _node = _parent.create(_cls, _nm)
            except Exception:
                report["warnings"].append("create[%d] %s failed: %s"
                    % (_i, _typ, traceback.format_exc().splitlines()[-1]))
                _created.append(None)
                continue

            _entry = {"name": _node.name, "path": _node.path, "type": _node.OPType}
            _created.append(_entry)
            report["created"].append(_entry)
            _name_to_path[_node.name] = _node.path

            for _pname, _pval in _kd["defaults"].items():
                try:
                    _node.par[_pname].val = _pval
                except Exception:
                    report["warnings"].append("default[%d].%s failed: %s"
                        % (_i, _pname, traceback.format_exc().splitlines()[-1]))

            for _pname, _pval in (_spec.get("params") or {}).items():
                try:
                    _v = _pval
                    if isinstance(_v, str) and _v in _name_to_path:
                        _v = _name_to_path[_v]
                    _node.par[_pname].val = _v
                except Exception:
                    report["warnings"].append("param[%d].%s failed: %s"
                        % (_i, _pname, traceback.format_exc().splitlines()[-1]))

            if _i > 0 and _created[_i - 1] is not None:
                try:
                    _prev = op(_created[_i - 1]["path"])
                    _node.inputConnectors[0].connect(_prev.outputConnectors[0])
                    report["connections"].append({"from": _prev.path, "to": _node.path,
                                                  "fromOut": 0, "toIn": 0})
                except Exception:
                    report["warnings"].append("connect[%d->%d] failed: %s"
                        % (_i - 1, _i, traceback.format_exc().splitlines()[-1]))

            for _j, _xpath in enumerate(_spec.get("extra_inputs") or []):
                try:
                    _xn = op(_xpath)
                    _node.inputConnectors[_j + 1].connect(_xn.outputConnectors[0])
                    report["connections"].append({"from": _xn.path, "to": _node.path,
                                                  "fromOut": 0, "toIn": _j + 1})
                except Exception:
                    report["warnings"].append("extra[%d.%d] %s failed: %s"
                        % (_i, _j + 1, _xpath, traceback.format_exc().splitlines()[-1]))

        if _created and _created[-1] is not None:
            report["output_path"] = _created[-1]["path"]
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildPopChainScript(payload: object): string {
  return buildPayloadScript(POP_CHAIN_SCRIPT, payload);
}

// ---------------------------------------------------------------------------
// Report type
// ---------------------------------------------------------------------------

interface PopChainReport {
  container: string;
  created: Array<{ name: string; path: string; type: string }>;
  connections: Array<{ from: string; to: string; fromOut: number; toIn: number }>;
  output_path: string | null;
  warnings: string[];
  unverified: string;
  fatal?: string;
}

// ---------------------------------------------------------------------------
// Impl
// ---------------------------------------------------------------------------

export async function buildPopChainImpl(ctx: ToolContext, args: BuildPopChainArgs) {
  return guardTd(
    async () => {
      const script = buildPopChainScript({
        parent: args.parent,
        name: args.name,
        chain: args.chain,
        defaults_map: DEFAULTS_MAP,
        unverified_note: UNVERIFIED_NOTE,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<PopChainReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`Could not build POP chain: ${report.fatal}`, report);
      }
      const warnPart = report.warnings.length ? `, ${report.warnings.length} warning(s)` : "";
      const outPart = report.output_path ? `, output ${report.output_path}` : "";
      const summary =
        `Built POP chain "${args.name}" under ${report.container}: ` +
        `${report.created.length}/${args.chain.length} node(s) created${warnPart}${outPart}.`;
      return jsonResult(summary, report);
    },
  );
}

// ---------------------------------------------------------------------------
// Registrar
// ---------------------------------------------------------------------------

export const registerBuildPopChain: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "build_pop_chain",
    {
      title: "Build POP chain",
      description:
        "Declarative Layer-2 builder for an ordered POP (Point OPerator) chain. " +
        "Pass a `chain` list of `{ type, name?, params?, extra_inputs? }` entries; " +
        "each chain[i] is wired output 0 → input 0 of chain[i+1] under `parent` " +
        "(default `/project1`). " +
        "Per-kind safe defaults are applied before user `params`; unknown par names " +
        "become warnings (fail-forward). " +
        "Multi-input POPs (merge, copy, feedback, proximity, switch, blend) accept " +
        "`extra_inputs` paths wired into input 1, 2, …. " +
        "POPs are Experimental — result carries `unverified` marker. " +
        "Tip: end the chain in a `null_pop` for a stable handoff to Wave-3 render rigs.",
      inputSchema: buildPopChainSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => buildPopChainImpl(ctx, args),
  );
};
