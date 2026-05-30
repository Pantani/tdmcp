import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const createTestPatternSchema = z.object({
  parent_path: z
    .string()
    .default("/project1")
    .describe(
      "Parent COMP path to build inside (e.g. '/project1'). The container is created here.",
    ),
  name: z
    .string()
    .default("test_pattern")
    .describe("Base name for the container COMP that wraps the pattern network."),
  pattern: z
    .enum(["grid", "crosshair", "color_bars", "ramp", "circle_grid"])
    .default("grid")
    .describe(
      "Pattern type: grid = even line grid; crosshair = centred cross + corner marks; " +
        "color_bars = vertical SMPTE-ish colour columns; ramp = smooth horizontal grey ramp; " +
        "circle_grid = repeated concentric ring tiles.",
    ),
  width: z.coerce
    .number()
    .int()
    .positive()
    .default(1920)
    .describe("Output width in pixels (must be > 0; e.g. 1920, 2560, 3840)."),
  height: z.coerce
    .number()
    .int()
    .positive()
    .default(1080)
    .describe("Output height in pixels (must be > 0; e.g. 1080, 1440, 2160)."),
  divisions: z.coerce
    .number()
    .int()
    .min(1)
    .default(16)
    .describe(
      "Number of grid cells across the frame for grid and circle_grid patterns (must be >= 1). Ignored by other patterns.",
    ),
  output_number: z.coerce
    .number()
    .int()
    .default(0)
    .describe(
      "Projector / output ID drawn as a large label in the lower-right corner. 0 = no number.",
    ),
  label: z
    .string()
    .default("")
    .describe(
      "Optional extra caption text overlaid bottom-right (e.g. 'LEFT', 'CAM 2'). Empty = none.",
    ),
  line_color: z
    .array(z.number())
    .length(3)
    .default([0, 1, 0])
    .describe("Pattern line colour as [R, G, B] in 0–1 range. Default is green [0, 1, 0]."),
  bg_color: z
    .array(z.number())
    .length(3)
    .default([0, 0, 0])
    .describe("Background colour as [R, G, B] in 0–1 range. Default is black [0, 0, 0]."),
});

export type CreateTestPatternArgs = z.infer<typeof createTestPatternSchema>;

// ---------------------------------------------------------------------------
// Report interface
// ---------------------------------------------------------------------------

interface TestPatternReport {
  container: string;
  output_top: string;
  pattern: string;
  width: number;
  height: number;
  warnings: string[];
  fatal?: string;
}

// ---------------------------------------------------------------------------
// Per-pattern GLSL generators
//
// GLSL rules obeyed throughout:
//   - `out vec4 fragColor;` declared (TD preamble does NOT declare it)
//   - `vUV.st` for 0..1 UV coordinates
//   - No built-in uTime (all patterns are STATIC)
//   - No #define names F1 / F2 (collide with TD preamble)
//   - TDOutputSwizzle() wraps every fragColor assignment
//   - Colours baked in as constants — zero per-uniform risk
// ---------------------------------------------------------------------------

function glslGrid(lc: readonly number[], bg: readonly number[], divisions: number): string {
  const lr = (lc[0] ?? 0).toFixed(4);
  const lg = (lc[1] ?? 0).toFixed(4);
  const lb = (lc[2] ?? 0).toFixed(4);
  const br = (bg[0] ?? 0).toFixed(4);
  const bgg = (bg[1] ?? 0).toFixed(4);
  const bb = (bg[2] ?? 0).toFixed(4);
  return `out vec4 fragColor;
void main(){
    float ndiv = float(${divisions});
    float lw = 0.5 / ndiv;
    vec2 scaled = vUV.st * ndiv;
    vec2 frac2 = fract(scaled);
    bool onLine = (frac2.x < lw || frac2.x > (1.0 - lw) ||
                   frac2.y < lw || frac2.y > (1.0 - lw));
    vec3 lineCol = vec3(${lr}, ${lg}, ${lb});
    vec3 bgCol   = vec3(${br}, ${bgg}, ${bb});
    fragColor = TDOutputSwizzle(vec4(onLine ? lineCol : bgCol, 1.0));
}`;
}

function glslCrosshair(lc: readonly number[], bg: readonly number[]): string {
  const lr = (lc[0] ?? 0).toFixed(4);
  const lg = (lc[1] ?? 0).toFixed(4);
  const lb = (lc[2] ?? 0).toFixed(4);
  const br = (bg[0] ?? 0).toFixed(4);
  const bgg = (bg[1] ?? 0).toFixed(4);
  const bb = (bg[2] ?? 0).toFixed(4);
  return `out vec4 fragColor;
void main(){
    vec2 uv = vUV.st;
    float hw = 0.004;
    // Centre cross
    bool cross = (abs(uv.x - 0.5) < hw || abs(uv.y - 0.5) < hw);
    // Corner marks: small L-brackets at all four corners
    float cm = 0.08;
    float cw = 0.004;
    bool corner =
        ((uv.x < cm && uv.y < cw)  || (uv.x < cw && uv.y < cm)) ||
        ((uv.x > (1.0-cm) && uv.y < cw)  || (uv.x > (1.0-cw) && uv.y < cm)) ||
        ((uv.x < cm && uv.y > (1.0-cw)) || (uv.x < cw && uv.y > (1.0-cm))) ||
        ((uv.x > (1.0-cm) && uv.y > (1.0-cw)) || (uv.x > (1.0-cw) && uv.y > (1.0-cm)));
    vec3 lineCol = vec3(${lr}, ${lg}, ${lb});
    vec3 bgCol   = vec3(${br}, ${bgg}, ${bb});
    fragColor = TDOutputSwizzle(vec4((cross || corner) ? lineCol : bgCol, 1.0));
}`;
}

function glslColorBars(bg: readonly number[]): string {
  // 7 classic SMPTE-ish bars (75% saturation); background only shows outside the bars area.
  const br = (bg[0] ?? 0).toFixed(4);
  const bgg = (bg[1] ?? 0).toFixed(4);
  const bb = (bg[2] ?? 0).toFixed(4);
  return `out vec4 fragColor;
void main(){
    float x = vUV.s;
    float seg = floor(x * 7.0);
    // 7-bar classic: white, yellow, cyan, green, magenta, red, blue
    vec3 bars[7];
    bars[0] = vec3(0.75, 0.75, 0.75);
    bars[1] = vec3(0.75, 0.75, 0.0);
    bars[2] = vec3(0.0,  0.75, 0.75);
    bars[3] = vec3(0.0,  0.75, 0.0);
    bars[4] = vec3(0.75, 0.0,  0.75);
    bars[5] = vec3(0.75, 0.0,  0.0);
    bars[6] = vec3(0.0,  0.0,  0.75);
    int idx = clamp(int(seg), 0, 6);
    vec3 col = bars[idx];
    // Narrow separator lines between bars
    float frac2 = fract(x * 7.0);
    if(frac2 < 0.02 || frac2 > 0.98) col = vec3(${br}, ${bgg}, ${bb});
    fragColor = TDOutputSwizzle(vec4(col, 1.0));
}`;
}

function glslRamp(lc: readonly number[], bg: readonly number[]): string {
  const lr = (lc[0] ?? 0).toFixed(4);
  const lg = (lc[1] ?? 0).toFixed(4);
  const lb = (lc[2] ?? 0).toFixed(4);
  const br = (bg[0] ?? 0).toFixed(4);
  const bgg = (bg[1] ?? 0).toFixed(4);
  const bb = (bg[2] ?? 0).toFixed(4);
  return `out vec4 fragColor;
void main(){
    float t = vUV.s;
    // Horizontal ramp: background colour at left, line colour at right
    vec3 ramp = mix(vec3(${br}, ${bgg}, ${bb}), vec3(${lr}, ${lg}, ${lb}), t);
    // Superimpose 10% tick marks every 10% along the ramp
    float tick = fract(t * 10.0);
    bool isTick = (tick < 0.015);
    float tickBrightness = (vUV.t > 0.85 || vUV.t < 0.15) ? 1.0 : 0.0;
    vec3 tickCol = mix(ramp, vec3(0.5, 0.5, 0.5), tickBrightness * (isTick ? 1.0 : 0.0));
    fragColor = TDOutputSwizzle(vec4(tickCol, 1.0));
}`;
}

function glslCircleGrid(lc: readonly number[], bg: readonly number[], divisions: number): string {
  const lr = (lc[0] ?? 0).toFixed(4);
  const lg = (lc[1] ?? 0).toFixed(4);
  const lb = (lc[2] ?? 0).toFixed(4);
  const br = (bg[0] ?? 0).toFixed(4);
  const bgg = (bg[1] ?? 0).toFixed(4);
  const bb = (bg[2] ?? 0).toFixed(4);
  return `out vec4 fragColor;
void main(){
    float ndiv = float(${divisions});
    // Tile space into cells of size 1/ndiv
    vec2 tiled = fract(vUV.st * ndiv) - 0.5;
    float dist = length(tiled);
    // Concentric rings at r = 0.1, 0.2, 0.3, 0.4
    float rw = 0.025;
    bool ring =
        (abs(dist - 0.10) < rw) ||
        (abs(dist - 0.20) < rw) ||
        (abs(dist - 0.30) < rw) ||
        (abs(dist - 0.42) < rw);
    // Centre dot
    bool dot = (dist < 0.04);
    vec3 lineCol = vec3(${lr}, ${lg}, ${lb});
    vec3 bgCol   = vec3(${br}, ${bgg}, ${bb});
    fragColor = TDOutputSwizzle(vec4((ring || dot) ? lineCol : bgCol, 1.0));
}`;
}

function buildShader(args: CreateTestPatternArgs): string {
  const lc = args.line_color as readonly number[];
  const bg = args.bg_color as readonly number[];
  switch (args.pattern) {
    case "grid":
      return glslGrid(lc, bg, args.divisions);
    case "crosshair":
      return glslCrosshair(lc, bg);
    case "color_bars":
      return glslColorBars(bg);
    case "ramp":
      return glslRamp(lc, bg);
    case "circle_grid":
      return glslCircleGrid(lc, bg, args.divisions);
  }
}

// ---------------------------------------------------------------------------
// Python bridge script
// ---------------------------------------------------------------------------
// GLSL shader is baked into the payload (base64) so it travels safely.
// TD par names used:
//   glslTOP: outputresolution, resolutionw, resolutionh (standard, UNVERIFIED-live but
//     consistent across all known TD builds for custom-resolution TOPs)
//   textTOP: text, fontsizex, fontcolorr/g/b/a, alignx, aligny (standard text TOP pars)
//   compositeTOP: operand = "over" (standard composite operand par, UNVERIFIED-live)
//   nullTOP: no pars set
// All par sets guarded individually; failures → warnings (fail-forward).
// ---------------------------------------------------------------------------

const TEST_PATTERN_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {
    "container": "",
    "output_top": "",
    "pattern": _p["pattern"],
    "width": _p["width"],
    "height": _p["height"],
    "warnings": [],
}
try:
    _parent = op(_p["parent_path"])
    if _parent is None:
        report["fatal"] = "Parent COMP not found: " + str(_p["parent_path"])
    else:
        # Create container COMP
        try:
            _cont = _parent.create(baseCOMP, _p["name"])
        except Exception as _e:
            report["fatal"] = "Could not create container: " + str(_e)
            _cont = None
        if _cont is not None:
            report["container"] = _cont.path

            # --- GLSL TOP: pattern generator ---
            _glsl = None
            try:
                _glsl = _cont.create(glslTOP, "pattern_gen")
            except Exception as _e:
                report["fatal"] = "Could not create glslTOP: " + str(_e)
                _glsl = None

            if _glsl is not None:
                # Write shader into a text DAT, then point the GLSL TOP at it
                _frag = None
                try:
                    _frag = _cont.create(textDAT, "pattern_frag")
                    _frag.text = _p["shader"]
                except Exception as _e:
                    report["warnings"].append("textDAT for shader failed: " + str(_e))

                if _frag is not None:
                    try:
                        _glsl.par.pixeldat = _frag.name
                    except Exception as _e:
                        report["warnings"].append("glslTOP.par.pixeldat failed: " + str(_e))

                # Set output resolution to custom width x height
                try:
                    _glsl.par.outputresolution = "custom"
                except Exception as _e:
                    report["warnings"].append("glslTOP.par.outputresolution failed: " + str(_e))
                try:
                    _glsl.par.resolutionw = _p["width"]
                except Exception as _e:
                    report["warnings"].append("glslTOP.par.resolutionw failed: " + str(_e))
                try:
                    _glsl.par.resolutionh = _p["height"]
                except Exception as _e:
                    report["warnings"].append("glslTOP.par.resolutionh failed: " + str(_e))

                # Determine whether to add a text overlay
                _need_overlay = (_p["output_number"] > 0 or _p["label"] != "")
                _overlay_text = ""
                if _p["output_number"] > 0 and _p["label"] != "":
                    _overlay_text = str(_p["output_number"]) + "  " + _p["label"]
                elif _p["output_number"] > 0:
                    _overlay_text = str(_p["output_number"])
                else:
                    _overlay_text = _p["label"]

                _out_node = _glsl  # will be replaced if overlay added

                if _need_overlay:
                    _txt = None
                    try:
                        _txt = _cont.create(textTOP, "label")
                        try:
                            _txt.par.text = _overlay_text
                        except Exception as _e:
                            report["warnings"].append("textTOP.par.text failed: " + str(_e))
                        try:
                            _txt.par.fontsizex = max(48, int(_p["height"] // 15))
                        except Exception as _e:
                            report["warnings"].append("textTOP.par.fontsizex failed: " + str(_e))
                        # Font colour = line_color
                        _lc = _p["line_color"]
                        try:
                            _txt.par.fontcolorr = _lc[0]
                            _txt.par.fontcolorg = _lc[1]
                            _txt.par.fontcolorb = _lc[2]
                            _txt.par.fontcolora = 1.0
                        except Exception as _e:
                            report["warnings"].append("textTOP font colour pars failed: " + str(_e))
                        # Align bottom-right
                        try:
                            _txt.par.alignx = "right"
                        except Exception as _e:
                            report["warnings"].append("textTOP.par.alignx failed: " + str(_e))
                        try:
                            _txt.par.aligny = "bottom"
                        except Exception as _e:
                            report["warnings"].append("textTOP.par.aligny failed: " + str(_e))
                        # Match resolution
                        try:
                            _txt.par.outputresolution = "custom"
                            _txt.par.resolutionw = _p["width"]
                            _txt.par.resolutionh = _p["height"]
                        except Exception as _e:
                            report["warnings"].append("textTOP resolution pars failed: " + str(_e))
                    except Exception as _e:
                        report["warnings"].append("textTOP creation failed: " + str(_e))
                        _txt = None

                    if _txt is not None:
                        # Composite: GLSL TOP (bg) + text TOP (fg) → "over"
                        _comp = None
                        try:
                            _comp = _cont.create(compositeTOP, "overlay")
                            _comp.inputConnectors[0].connect(_glsl)
                            _comp.inputConnectors[1].connect(_txt)
                            try:
                                _comp.par.operand = "over"
                            except Exception as _e:
                                report["warnings"].append(
                                    "compositeTOP.par.operand='over' failed: " + str(_e)
                                )
                            _out_node = _comp
                        except Exception as _e:
                            report["warnings"].append("compositeTOP creation failed: " + str(_e))

                # --- Null TOP: stable output handle ---
                try:
                    _null = _cont.create(nullTOP, "out")
                    _null.inputConnectors[0].connect(_out_node)
                    report["output_top"] = _null.path
                except Exception as _e:
                    report["output_top"] = _out_node.path if _out_node else ""
                    report["warnings"].append("nullTOP creation failed: " + str(_e))
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildTestPatternScript(payload: object): string {
  return buildPayloadScript(TEST_PATTERN_SCRIPT, payload);
}

// ---------------------------------------------------------------------------
// Impl
// ---------------------------------------------------------------------------

export async function createTestPatternImpl(
  ctx: ToolContext,
  args: CreateTestPatternArgs,
): Promise<import("@modelcontextprotocol/sdk/types.js").CallToolResult> {
  const shader = buildShader(args);
  return guardTd(
    async () => {
      const script = buildTestPatternScript({
        parent_path: args.parent_path,
        name: args.name,
        pattern: args.pattern,
        width: args.width,
        height: args.height,
        divisions: args.divisions,
        output_number: args.output_number,
        label: args.label,
        line_color: args.line_color,
        bg_color: args.bg_color,
        shader,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<TestPatternReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`Test pattern build failed: ${report.fatal}`, report);
      }
      const warnNote = report.warnings.length > 0 ? `, ${report.warnings.length} warning(s)` : "";
      const overlayParts = [args.output_number > 0 ? String(args.output_number) : "", args.label]
        .filter(Boolean)
        .join(" ");
      const labelNote = overlayParts ? ` with overlay "${overlayParts}"` : "";
      const summary =
        `Created ${report.pattern} test pattern at ${report.width}×${report.height}` +
        `${labelNote} → ${report.output_top}${warnNote}.`;
      return jsonResult(summary, report);
    },
  );
}

// ---------------------------------------------------------------------------
// Registrar
// ---------------------------------------------------------------------------

export const registerCreateTestPattern: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_test_pattern",
    {
      title: "Create test pattern",
      description:
        "Generate a projector calibration / alignment source — a standalone test-pattern network " +
        "that every media server ships and tdmcp was missing. Builds a baseCOMP containing a " +
        "GLSL TOP with a baked-in static pattern (grid, crosshair, SMPTE-ish color bars, " +
        "horizontal ramp, or circle-grid), optional text/number overlay (for per-projector ID), " +
        "and a Null TOP as the stable output handle. The shader is generated per pattern and " +
        "baked into the payload — no custom uniforms or live bindings needed. Use the output " +
        "as a routing source during projector alignment, LED mapping calibration, or camera " +
        "registration. Pattern, resolution, divisions, overlay number/label, and colours are " +
        "all configurable.",
      inputSchema: createTestPatternSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createTestPatternImpl(ctx, args),
  );
};
