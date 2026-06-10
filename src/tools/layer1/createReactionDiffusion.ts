import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { buildFromRecipe, finalize, runBuild } from "./orchestration.js";

// ---------------------------------------------------------------------------
// Palette definitions: each palette is a list of rampTOP key entries.
// rampTOP keys: pos (0–1), r, g, b, a.
// ---------------------------------------------------------------------------
interface RampKey {
  pos: number;
  r: number;
  g: number;
  b: number;
  a: number;
}

const PALETTES: Record<string, RampKey[]> = {
  coral: [
    { pos: 0.0, r: 0.16, g: 0.04, b: 0.24, a: 1 }, // deep purple
    { pos: 0.35, r: 0.72, g: 0.15, b: 0.55, a: 1 }, // magenta
    { pos: 0.7, r: 0.95, g: 0.75, b: 0.6, a: 1 }, // cream
    { pos: 1.0, r: 1.0, g: 1.0, b: 1.0, a: 1 }, // white
  ],
  spots: [
    { pos: 0.0, r: 0.0, g: 0.0, b: 0.0, a: 1 }, // black
    { pos: 0.5, r: 0.0, g: 0.85, b: 0.9, a: 1 }, // cyan
    { pos: 1.0, r: 1.0, g: 1.0, b: 1.0, a: 1 }, // white
  ],
  stripes: [
    { pos: 0.0, r: 0.2, g: 0.05, b: 0.55, a: 1 }, // indigo
    { pos: 0.45, r: 0.1, g: 0.7, b: 0.3, a: 1 }, // green
    { pos: 1.0, r: 0.95, g: 0.9, b: 0.2, a: 1 }, // yellow
  ],
  mitosis: [
    { pos: 0.0, r: 0.55, g: 0.0, b: 0.04, a: 1 }, // blood-red
    { pos: 0.5, r: 0.95, g: 0.42, b: 0.08, a: 1 }, // orange
    { pos: 1.0, r: 0.93, g: 0.88, b: 0.78, a: 1 }, // bone-white
  ],
};

// ---------------------------------------------------------------------------
// Post-recipe Python overlay
// ---------------------------------------------------------------------------
const OVERLAY_SCRIPT = `
import json, traceback, base64
_payload = json.loads(base64.b64decode("__PAYLOAD_B64__").decode())
report = {"warnings": [], "lut_chain": False, "iterations_applied": False}
try:
    _base   = _payload["container_path"]

    seed1     = op(_base + "/seed1")
    glsl1     = op(_base + "/glsl1")
    glsl1_frag = op(_base + "/glsl1_frag")
    out1      = op(_base + "/out1")
    feedback1 = op(_base + "/feedback1")

    # 1. Override seed resolution
    _res = int(_payload["resolution"])
    if seed1 is not None:
        seed1.par.resolutionw = _res
        seed1.par.resolutionh = _res
    else:
        report["warnings"].append("seed1 not found; resolution not set")

    # 2. Set uFeed/uKill/uDa/uDb via the seq.vec on the glslTOP (canonical pattern
    # mirrors src/tools/layer2/createGlslShader.ts L115-117: set numBlocks on the
    # sequence, then write vec<i>name / vec<i>valuex on the NODE par directly).
    if glsl1 is not None:
        glsl1.seq.vec.numBlocks = max(glsl1.seq.vec.numBlocks, 4)
        for _i, _spec in enumerate([
            ("uFeed", float(_payload["F"])),
            ("uKill", float(_payload["K"])),
            ("uDa", float(_payload["Da"])),
            ("uDb", float(_payload["Db"])),
        ]):
            _uname, _uval = _spec
            try:
                setattr(glsl1.par, "vec%dname" % _i, _uname)
                setattr(glsl1.par, "vec%dvaluex" % _i, _uval)
            except Exception as _e:
                report["warnings"].append("Could not bind %s: %s" % (_uname, str(_e)))
    else:
        report["warnings"].append("glsl1 not found; uFeed/uKill/uDa/uDb not set")

    # 4. Patch the GLSL shader to use uDa/uDb uniforms instead of hard-coded constants
    if glsl1_frag is not None:
        _src = glsl1_frag.text
        _patched = _src
        _sentinels = [
            ("float da = 1.0 * lap.r", "float da = uDa * lap.r"),
            ("float db = 0.5 * lap.g", "float db = uDb * lap.g"),
        ]
        _all_replaced = True
        for _old, _new in _sentinels:
            if _old in _patched:
                _patched = _patched.replace(_old, _new)
            else:
                report["warnings"].append("Shader sentinel not found: " + _old)
                _all_replaced = False
        if _all_replaced:
            # Prepend uniform declarations if not already present
            _decl = "uniform float uDa;\\nuniform float uDb;\\n"
            if "uniform float uDa" not in _patched:
                _insert = _patched.find("uniform float uFeed;")
                if _insert >= 0:
                    _patched = _patched[:_insert] + _decl + _patched[_insert:]
                else:
                    _patched = _decl + _patched
            glsl1_frag.text = _patched
    else:
        report["warnings"].append("glsl1_frag not found; shader not patched for uDa/uDb")

    # 5. Iterations — UNVERIFIED mechanism; fall back with warning
    _iters = int(_payload["iterations"])
    if _iters > 1:
        # Attempt: feedback1 cookrate is not a standard TD parameter for feedbackTOP.
        # Best known workaround: leave iterations=1 and warn. Live probe required.
        report["warnings"].append(
            "iterations>1 unverified: feedbackTOP has no cookrate par; "
            "multi-step sub-frame looping not available via standard API. "
            "Effective iterations=1."
        )
    else:
        report["iterations_applied"] = True

    # 6. Optional LUT chain (rampTOP + lookupTOP)
    _palette = _payload.get("palette", "coral")
    _keys = _payload.get("palette_keys", [])
    if _palette != "none" and _keys:
        # Fail-forward: if any rampTOP seq par doesn't match this TD build's API,
        # the RD GLSL chain still ships and the LUT step becomes a warning.
        try:
            _lut_ramp = op(_base).create("rampTOP", "lut_ramp")
            _lut_ramp.par.resolutionw = 256
            _lut_ramp.par.resolutionh = 1
            _lut_ramp.par.outputresolution = "custom"
            try:
                _lut_ramp.par.numkeys = len(_keys)
            except Exception:
                pass
            for _ki, _k in enumerate(_keys):
                try:
                    setattr(_lut_ramp.par, "key%dpos" % _ki, float(_k["pos"]))
                    setattr(_lut_ramp.par, "key%dcolorr" % _ki, float(_k["r"]))
                    setattr(_lut_ramp.par, "key%dcolorg" % _ki, float(_k["g"]))
                    setattr(_lut_ramp.par, "key%dcolorb" % _ki, float(_k["b"]))
                    setattr(_lut_ramp.par, "key%dcolora" % _ki, float(_k.get("a", 1.0)))
                except Exception as _e:
                    report["warnings"].append("ramp key %d par-set failed: %s" % (_ki, str(_e)))

            _lut_apply = op(_base).create("lookupTOP", "lut_apply")
            _lut_apply.inputConnectors[0].connect(glsl1)
            _lut_apply.inputConnectors[1].connect(_lut_ramp)
            if out1 is not None:
                out1.inputConnectors[0].connect(_lut_apply)

            report["lut_chain"] = True
            report["lut_ramp"]  = _lut_ramp.path
            report["lut_apply"] = _lut_apply.path
        except Exception as _e:
            report["warnings"].append("LUT chain partial: %s" % str(_e))
            report["lut_chain"] = False

except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]

result = json.dumps(report)
print(result)
`;

interface OverlayReport {
  warnings: string[];
  lut_chain: boolean;
  iterations_applied: boolean;
  lut_ramp?: string;
  lut_apply?: string;
  fatal?: string;
}

// ---------------------------------------------------------------------------
// Zod schema
// ---------------------------------------------------------------------------
export const createReactionDiffusionSchema = z.object({
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP path the reaction-diffusion container is created inside."),
  name: z.string().default("reaction_diffusion").describe("Base name for the created container."),
  F: z
    .number()
    .min(0)
    .max(0.1)
    .default(0.055)
    .describe(
      "Gray-Scott feed rate (uniform uFeed). Controls how fast chemical A is replenished. Lower = sparser, more open patterns; higher = denser maze-like structures.",
    ),
  K: z
    .number()
    .min(0)
    .max(0.1)
    .default(0.062)
    .describe(
      "Gray-Scott kill rate (uniform uKill). Controls how fast chemical B is removed. Tune alongside F to shift between spots, stripes, and maze regimes.",
    ),
  Da: z
    .number()
    .min(0)
    .max(2)
    .default(1.0)
    .describe(
      "Diffusion rate of chemical A (uniform uDa). Default 1.0. Increasing slows pattern growth; the recipe default is 1.0.",
    ),
  Db: z
    .number()
    .min(0)
    .max(2)
    .default(0.5)
    .describe(
      "Diffusion rate of chemical B (uniform uDb). Default 0.5. Tuning relative to Da changes pattern sharpness.",
    ),
  iterations: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(5)
    .describe(
      "Simulation steps per rendered frame. UNVERIFIED — feedbackTOP has no native cookrate param; effective value is 1 with a warning if >1 is requested. Field retained for forward-compatibility.",
    ),
  palette: z
    .enum(["coral", "spots", "stripes", "mitosis", "none"])
    .default("coral")
    .describe(
      "Post-sim color LUT applied via a rampTOP + lookupTOP downstream of the GLSL simulation. 'coral' = deep-purple→magenta→cream→white; 'spots' = black→cyan→white; 'stripes' = indigo→green→yellow; 'mitosis' = blood-red→orange→bone-white; 'none' = raw simulation state (R=A, G=B).",
    ),
  resolution: z
    .number()
    .int()
    .min(64)
    .max(2048)
    .default(256)
    .describe(
      "Square simulation grid size in pixels. Overrides seed1.resolutionw/h. Higher values produce finer detail at higher GPU cost.",
    ),
});

type CreateReactionDiffusionArgs = z.infer<typeof createReactionDiffusionSchema>;

// ---------------------------------------------------------------------------
// Impl
// ---------------------------------------------------------------------------
export async function createReactionDiffusionImpl(
  ctx: ToolContext,
  args: CreateReactionDiffusionArgs,
) {
  const recipe = ctx.recipes.get("reaction_diffusion");
  if (!recipe) {
    return errorResult(
      "Recipe 'reaction_diffusion' not found. Run 'npm run import:bottobot' to populate recipes.",
    );
  }

  return runBuild(async () => {
    // 1. Delegate to buildFromRecipe — creates the base network
    const built = await buildFromRecipe(ctx, recipe, args.parent_path);

    // 2. Post-recipe overlay: resolution + uniforms + shader patch + optional LUT
    const paletteKeys = args.palette !== "none" ? (PALETTES[args.palette] ?? []) : [];
    const overlayScript = buildPayloadScript(OVERLAY_SCRIPT, {
      parent_path: args.parent_path,
      container_path: built.builder.containerPath,
      resolution: args.resolution,
      F: args.F,
      K: args.K,
      Da: args.Da,
      Db: args.Db,
      iterations: args.iterations,
      palette: args.palette,
      palette_keys: paletteKeys,
    });

    const exec = await ctx.client.executePythonScript(overlayScript, true);

    // Parse overlay report (stdout may be empty if the bridge version pre-dates result echo)
    let overlayReport: OverlayReport = { warnings: [], lut_chain: false, iterations_applied: true };
    if (exec.stdout?.trim()) {
      try {
        overlayReport = parsePythonReport<OverlayReport>(exec.stdout);
      } catch {
        overlayReport.warnings.push(
          "Could not parse overlay report; overlay may have partially applied.",
        );
      }
    }

    if (overlayReport.fatal) {
      return errorResult(
        `Reaction-diffusion overlay failed: ${overlayReport.fatal}`,
        overlayReport,
      );
    }

    // Collect all warnings
    const allWarnings = [...built.builder.warnings, ...overlayReport.warnings];

    // 3. Finalize: auto-layout + expose controls + preview
    return finalize(ctx, {
      summary: buildSummary(args, overlayReport, allWarnings),
      builder: built.builder,
      outputPath: built.outputPath,
      controls: buildControls(args),
      recipeId: recipe.id,
      extra: {
        recipe: recipe.id,
        palette: args.palette,
        lut_chain: overlayReport.lut_chain,
        resolution: args.resolution,
        F: args.F,
        K: args.K,
        Da: args.Da,
        Db: args.Db,
        iterations: args.iterations,
        warnings: allWarnings,
      },
    });
  });
}

function buildSummary(
  args: CreateReactionDiffusionArgs,
  _report: OverlayReport,
  warnings: string[],
): string {
  const palNote = args.palette === "none" ? "raw simulation output" : `${args.palette} palette LUT`;
  const iterNote =
    args.iterations > 1
      ? ` (iterations=${args.iterations} requested but unverified — effective 1)`
      : "";
  const warnNote = warnings.length > 0 ? ` ${warnings.length} warning(s).` : "";
  return (
    `Built Gray-Scott reaction-diffusion (F=${args.F}, K=${args.K}, Da=${args.Da}, Db=${args.Db}) ` +
    `at ${args.resolution}×${args.resolution}px with ${palNote}${iterNote}.${warnNote}`
  );
}

function buildControls(args: CreateReactionDiffusionArgs): ControlSpec[] {
  return [
    {
      name: "F",
      type: "float",
      label: "Feed Rate",
      default: args.F,
      min: 0,
      max: 0.1,
      bind_to: ["glsl1.vec0valuex"],
    },
    {
      name: "K",
      type: "float",
      label: "Kill Rate",
      default: args.K,
      min: 0,
      max: 0.1,
      bind_to: ["glsl1.vec1valuex"],
    },
    {
      name: "Da",
      type: "float",
      label: "Diffusion A",
      default: args.Da,
      min: 0,
      max: 2,
      bind_to: ["glsl1.vec2valuex"],
    },
    {
      name: "Db",
      type: "float",
      label: "Diffusion B",
      default: args.Db,
      min: 0,
      max: 2,
      bind_to: ["glsl1.vec3valuex"],
    },
    {
      name: "Iterations",
      type: "int",
      label: "Iterations",
      default: args.iterations,
      min: 1,
      max: 20,
    },
    {
      name: "Resolution",
      type: "int",
      label: "Resolution",
      default: args.resolution,
      min: 64,
      max: 2048,
      bind_to: ["seed1.resolutionw", "seed1.resolutionh"],
    },
    {
      name: "Palette",
      type: "menu",
      label: "Palette",
      default: args.palette,
    },
  ];
}

// ---------------------------------------------------------------------------
// Registrar
// ---------------------------------------------------------------------------
export const registerCreateReactionDiffusion: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_reaction_diffusion",
    {
      title: "Create reaction diffusion",
      description:
        "Build a Gray-Scott reaction-diffusion GPU simulation as a ready-to-use visual system. " +
        "Delegates to the built-in 'reaction_diffusion' recipe (seed GLSL TOP → feedbackTOP → " +
        "simulation GLSL TOP → null output), then overlays caller-provided Gray-Scott parameters " +
        "(Feed rate F, Kill rate K, diffusion coefficients Da/Db) as GLSL uniforms, patches the " +
        "shader so da/db use the uniforms instead of hard-coded constants, and optionally chains a " +
        "rampTOP + lookupTOP for a color LUT (coral / spots / stripes / mitosis presets). Exposes " +
        "a control panel with sliders for F, K, Da, Db, resolution, and a palette menu. Output " +
        "node is a nullTOP ready for downstream wiring. 'iterations>1' is unverified — effective " +
        "value is 1 with a warning.",
      inputSchema: createReactionDiffusionSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createReactionDiffusionImpl(ctx, args),
  );
};
