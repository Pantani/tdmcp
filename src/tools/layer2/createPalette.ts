import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

// A Constant CHOP holds 40 channels; at 3 channels (RGB) per swatch that is 13 swatches.
const MAX_SWATCHES = 13;

const PALETTE_RULES = ["complementary", "analogous", "triad", "tetrad", "monochrome"] as const;
type PaletteRule = (typeof PALETTE_RULES)[number];

export const createPaletteSchema = z.object({
  mode: z
    .enum(["harmony", "from_source"])
    .default("harmony")
    .describe(
      "How swatches are derived: 'harmony' computes them from a base hue + a colour-theory rule (pure maths); 'from_source' samples dominant colours from a source TOP.",
    ),
  base_hue: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0.0)
    .describe(
      "(harmony) Base hue on the colour wheel, 0..1 (0 = red, 0.333 = green, 0.666 = blue).",
    ),
  saturation: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0.7)
    .describe("(harmony) Base saturation 0..1 (0 = grey, 1 = vivid)."),
  value: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0.9)
    .describe("(harmony) Base value / brightness 0..1."),
  rule: z
    .enum(PALETTE_RULES)
    .default("triad")
    .describe(
      "(harmony) Colour-theory spread: complementary (base + opposite), analogous (neighbours), triad (3 evenly spaced), tetrad (4 evenly spaced), monochrome (one hue, varied brightness).",
    ),
  count: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_SWATCHES)
    .default(5)
    .describe(
      `Number of swatches to produce (1..${MAX_SWATCHES}; capped because the swatch Constant CHOP holds 40 channels = 13 RGB swatches).`,
    ),
  analogous_spread: z.coerce
    .number()
    .min(0)
    .max(0.5)
    .default(0.083)
    .describe("(harmony, analogous rule) Hue step between neighbours, 0..0.5 (0.083 ≈ 30°)."),
  source: z
    .string()
    .optional()
    .describe(
      "(from_source) Absolute path of a TOP to sample dominant colours from. It is down-res'd to a tiny image and its pixels are read back; if missing/unreadable the palette falls back to a neutral greyscale ramp.",
    ),
  parent_path: z
    .string()
    .default("/project1")
    .describe("COMP to build the Ramp TOP + swatch CHOP inside."),
  name: z.string().default("palette").describe("Base name for the created nodes."),
  expose_controls: z
    .boolean()
    .default(true)
    .describe("Add BaseHue / Saturation / Value / Rule / Count custom parameters to parent_path."),
});
type CreatePaletteArgs = z.infer<typeof createPaletteSchema>;

/** One swatch colour, channels in 0..1. */
export interface Swatch {
  r: number;
  g: number;
  b: number;
}

/** Wrap a hue into the [0, 1) range. */
function wrapHue(h: number): number {
  const x = h % 1;
  return x < 0 ? x + 1 : x;
}

/**
 * HSV→RGB using the standard sextant algorithm. h/s/v in 0..1, returns r/g/b in 0..1.
 * Kept pure so the harmony maths is unit-testable without a client.
 */
export function hsvToRgb(h: number, s: number, v: number): Swatch {
  const hue = wrapHue(h);
  const sat = Math.min(1, Math.max(0, s));
  const val = Math.min(1, Math.max(0, v));
  if (sat === 0) return { r: val, g: val, b: val };
  const i = Math.floor(hue * 6);
  const f = hue * 6 - i;
  const p = val * (1 - sat);
  const q = val * (1 - sat * f);
  const t = val * (1 - sat * (1 - f));
  switch (i % 6) {
    case 0:
      return { r: val, g: t, b: p };
    case 1:
      return { r: q, g: val, b: p };
    case 2:
      return { r: p, g: val, b: t };
    case 3:
      return { r: p, g: q, b: val };
    case 4:
      return { r: t, g: p, b: val };
    default:
      return { r: val, g: p, b: q };
  }
}

/**
 * The hue anchors for a colour-theory rule, before they are repeated/varied to reach
 * `count`. Monochrome returns a single anchor (the base hue) and varies value instead.
 */
function ruleAnchors(rule: PaletteRule, baseHue: number, spread: number): number[] {
  switch (rule) {
    case "complementary":
      return [baseHue, baseHue + 0.5];
    case "analogous":
      return [baseHue, baseHue + spread, baseHue - spread];
    case "triad":
      return [baseHue, baseHue + 1 / 3, baseHue + 2 / 3];
    case "tetrad":
      return [baseHue, baseHue + 0.25, baseHue + 0.5, baseHue + 0.75];
    default:
      return [baseHue];
  }
}

/**
 * Compute `count` swatches for a harmony rule. Pure — no client. The first
 * `anchors.length` swatches sit exactly on the rule's anchors at full saturation/
 * value; extra swatches reuse the anchors with progressively dimmer value so a high
 * count still produces distinct, ordered colours. Monochrome holds the base hue and
 * sweeps value dark→bright across all `count` steps.
 */
export function computePaletteSwatches(args: {
  rule: PaletteRule;
  base_hue: number;
  saturation: number;
  value: number;
  count: number;
  analogous_spread?: number;
}): Swatch[] {
  const { rule, base_hue, saturation, value, count } = args;
  const spread = args.analogous_spread ?? 0.083;

  if (rule === "monochrome") {
    const out: Swatch[] = [];
    for (let i = 0; i < count; i++) {
      // Sweep value from ~0.35·value up to value; nudge saturation down as it brightens.
      const t = count === 1 ? 1 : i / (count - 1);
      const v = value * (0.35 + 0.65 * t);
      const s = saturation * (1 - 0.25 * t);
      out.push(hsvToRgb(base_hue, s, v));
    }
    return out;
  }

  const anchors = ruleAnchors(rule, base_hue, spread).map(wrapHue);
  const out: Swatch[] = [];
  for (let i = 0; i < count; i++) {
    const anchor = anchors[i % anchors.length] ?? base_hue;
    // Each full cycle through the anchors dims the value a little so repeats stay distinct.
    const cycle = Math.floor(i / anchors.length);
    const v = value * 0.85 ** cycle;
    out.push(hsvToRgb(anchor, saturation, v));
  }
  return out;
}

interface PaletteReport {
  ramp?: string;
  swatch_chop?: string;
  key_dat?: string;
  swatches: Swatch[];
  channels: string[];
  controls: string[];
  sampled?: boolean;
  warnings: string[];
  errors?: string[];
  fatal?: string;
}

// One Python pass builds the whole palette so the gradient + swatches + controls are
// created atomically. Ramp TOP key colours are set via a docked Table DAT (rows
// `pos r g b a`) referenced by the Ramp's `dat`/`dator` parameters with the colour
// source mode — the documented programmatic mechanism (the interactive ramp bar has no
// direct Python list). The swatch values are exposed on a Constant CHOP as named
// channels swatch{i}r/g/b so bind_to_channel / create_color_grade can read them by
// absolute path (op('…')['swatch0r']) with no cross-container wire. In from_source mode
// the source TOP is down-res'd and its pixels are read back to overwrite the swatches.
// ParMode is not in the exec globals, so any expression-mode work is avoided here.
const PALETTE_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"swatches": [], "channels": [], "controls": [], "warnings": []}
try:
    _parent = op(_p["parent"])
    if _parent is None:
        report["fatal"] = "Parent COMP not found: " + str(_p["parent"])
    else:
        _name = _p["name"]; _count = int(_p["count"])
        _sw = [dict(c) for c in _p.get("swatches", [])]
        # from_source: down-res the source TOP and read back representative pixels.
        report["sampled"] = False
        if _p["mode"] == "from_source":
            _src = op(_p.get("source") or "")
            if _src is None:
                report["warnings"].append("Source TOP not found: %s; using a greyscale fallback palette." % _p.get("source"))
                _sw = [{"r": t, "g": t, "b": t} for t in [i / max(1, _count - 1) for i in range(_count)]]
            else:
                try:
                    _res = _parent.create(resolutionTOP, _name + "_sample")
                    _res.inputConnectors[0].connect(_src)
                    _res.par.outputresolution = "custom"
                    _res.par.resolutionw = 4; _res.par.resolutionh = 4
                    _arr = _res.numpyArray(delayed=False)
                    _pix = []
                    if _arr is not None:
                        _h = _arr.shape[0]; _w = _arr.shape[1]
                        for _yy in range(_h):
                            for _xx in range(_w):
                                _px = _arr[_yy][_xx]
                                _pix.append({"r": float(_px[0]), "g": float(_px[1]), "b": float(_px[2])})
                    if _pix:
                        # Evenly spaced picks across the sampled cells.
                        _sw = [ _pix[int(round(i * (len(_pix) - 1) / max(1, _count - 1)))] for i in range(_count) ]
                        report["sampled"] = True
                    else:
                        report["warnings"].append("Source produced no pixels (paused/empty?); using a greyscale fallback.")
                        _sw = [{"r": t, "g": t, "b": t} for t in [i / max(1, _count - 1) for i in range(_count)]]
                except Exception:
                    report["warnings"].append("Could not sample source: " + traceback.format_exc().splitlines()[-1])
                    _sw = [{"r": t, "g": t, "b": t} for t in [i / max(1, _count - 1) for i in range(_count)]]
        _sw = _sw[:_count]
        if not _sw:
            _sw = [{"r": 1.0, "g": 1.0, "b": 1.0}]
        report["swatches"] = _sw
        _n = len(_sw)
        # Table DAT of ramp key colours: header + one row per swatch at an even position.
        _dat = _parent.create(tableDAT, _name + "_keys")
        _dat.clear()
        _dat.appendRow(["pos", "r", "g", "b", "a"])
        for _i, _c in enumerate(_sw):
            _pos = 0.0 if _n <= 1 else _i / (_n - 1)
            _dat.appendRow([repr(round(_pos, 6)), repr(round(_c["r"], 6)), repr(round(_c["g"], 6)), repr(round(_c["b"], 6)), "1.0"])
        report["key_dat"] = _dat.path
        # Ramp TOP driven by that table. Try the colour-from-DAT source params; tolerate
        # token differences across builds (warn, keep the default ramp) instead of erroring.
        _ramp = _parent.create(rampTOP, _name)
        try:
            _ramp.par.type = "horizontal"
        except Exception:
            report["warnings"].append("Could not set Ramp type.")
        _set_dat = False
        for _src_par in ("dator", "source"):
            _pr = getattr(_ramp.par, _src_par, None)
            if _pr is not None:
                try:
                    _pr.val = "dat"; _set_dat = True
                except Exception:
                    pass
        for _dat_par in ("dat", "ramp", "colordat"):
            _pr = getattr(_ramp.par, _dat_par, None)
            if _pr is not None:
                try:
                    _pr.val = _dat.path; _set_dat = True
                except Exception:
                    pass
        if not _set_dat:
            report["warnings"].append("Could not point the Ramp TOP at the key-colour DAT (param tokens differ on this build); the gradient may show defaults. Swatches are still exposed on the CHOP.")
        report["ramp"] = _ramp.path
        # Constant CHOP exposing swatch{i}r/g/b channels for bind_to_channel / color_grade.
        _const = _parent.create(constantCHOP, _name + "_swatches")
        _chans = []
        _k = 0
        for _i, _c in enumerate(_sw):
            for _comp, _vv in (("r", _c["r"]), ("g", _c["g"]), ("b", _c["b"])):
                _cn = "swatch%d%s" % (_i, _comp)
                _np = getattr(_const.par, "const%dname" % _k, None)
                _vp = getattr(_const.par, "const%dvalue" % _k, None)
                if _np is not None and _vp is not None:
                    _np.val = _cn; _vp.val = round(_vv, 6); _chans.append(_cn)
                _k += 1
        report["swatch_chop"] = _const.path
        report["channels"] = _chans
        # Optional live controls on the parent (informational re-run knobs).
        if _p.get("expose_controls"):
            try:
                _pg = _parent.appendCustomPage("Palette")
                _bh = _pg.appendFloat("Basehue", label="Base Hue")[0]; _bh.normMin = 0; _bh.normMax = 1; _bh.default = _p["base_hue"]; _bh.val = _p["base_hue"]
                _st = _pg.appendFloat("Saturation")[0]; _st.normMin = 0; _st.normMax = 1; _st.default = _p["saturation"]; _st.val = _p["saturation"]
                _vl = _pg.appendFloat("Value")[0]; _vl.normMin = 0; _vl.normMax = 1; _vl.default = _p["value"]; _vl.val = _p["value"]
                _rl = _pg.appendMenu("Rule")[0]; _rl.menuNames = _p["rules"]; _rl.menuLabels = _p["rules"]; _rl.default = _p["rule"]; _rl.val = _p["rule"]
                _ct = _pg.appendInt("Count")[0]; _ct.normMin = 1; _ct.normMax = ${MAX_SWATCHES}; _ct.default = _count; _ct.val = _count
                report["controls"] = ["Basehue", "Saturation", "Value", "Rule", "Count"]
            except Exception:
                report["warnings"].append("Could not append custom controls: " + traceback.format_exc().splitlines()[-1])
        report["errors"] = [str(e) for e in _ramp.errors()][:3]
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildPaletteScript(payload: object): string {
  return buildPayloadScript(PALETTE_SCRIPT, payload);
}

export async function createPaletteImpl(ctx: ToolContext, args: CreatePaletteArgs) {
  // Harmony maths is computed here (pure + testable); from_source defers to the Python
  // pass (the source pixels only exist live). Either way the script receives a concrete
  // swatch list it can fall back to.
  const swatches =
    args.mode === "harmony"
      ? computePaletteSwatches({
          rule: args.rule,
          base_hue: args.base_hue,
          saturation: args.saturation,
          value: args.value,
          count: args.count,
          analogous_spread: args.analogous_spread,
        })
      : [];

  return guardTd(
    async () => {
      const script = buildPaletteScript({
        mode: args.mode,
        parent: args.parent_path,
        name: args.name,
        count: args.count,
        source: args.source ?? null,
        expose_controls: args.expose_controls,
        rule: args.rule,
        rules: [...PALETTE_RULES],
        base_hue: args.base_hue,
        saturation: args.saturation,
        value: args.value,
        swatches,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<PaletteReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`Could not create palette: ${report.fatal}`, report);
      }
      const errs = report.errors?.length ? `, ${report.errors.length} node error(s)` : "";
      const warns = report.warnings.length ? `, ${report.warnings.length} warning(s)` : "";
      const how =
        args.mode === "from_source"
          ? report.sampled
            ? `sampled from ${args.source}`
            : "greyscale fallback (source unavailable)"
          : `${args.rule} from base hue ${args.base_hue}`;
      return jsonResult(
        `Built a ${report.swatches.length}-swatch palette (${how}) → gradient ${report.ramp}, swatches ${report.swatch_chop} (${report.channels.length} channels)${errs}${warns}.`,
        report,
      );
    },
  );
}

export const registerCreatePalette: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_palette",
    {
      title: "Create colour palette / gradient",
      description:
        "Generate a reusable colour palette + gradient other tools can bind to. In 'harmony' mode it computes N swatches from a base hue and a colour-theory rule (complementary / analogous / triad / tetrad / monochrome); in 'from_source' mode it samples dominant colours from a source TOP. It builds a Ramp TOP gradient (key colours from a docked Table DAT) plus a Constant CHOP exposing each swatch as swatch{i}r/g/b channels — feed those into create_color_grade, generate_from_moodboard or bind_to_channel. Live BaseHue / Saturation / Value / Rule / Count controls are exposed on the parent. Builds standalone (a harmony palette needs no source).",
      inputSchema: createPaletteSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createPaletteImpl(ctx, args),
  );
};
