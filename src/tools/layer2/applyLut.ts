import { existsSync } from "node:fs";
import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const applyLutSchema = z.object({
  lut_path: z
    .string()
    .describe(
      "Absolute path to the LUT file. Accepts `.cube`, `.3dl`, `.cc`, `.ccc` (routed to " +
        "OpenColorIO when available, otherwise parsed in Python for `.cube` or loaded via " +
        "Movie File In for image-format LUTs). PNG/EXR/etc. always use the Movie File In + " +
        "Lookup TOP fallback.",
    ),
  source_path: z
    .string()
    .optional()
    .describe(
      "Absolute TD path of the existing TOP to grade (e.g. '/project1/render1'). " +
        "TD wires can't cross COMPs, so the source is pulled in via a Select TOP referencing " +
        "the absolute path. When omitted, a Constant TOP (mid-grey, 1280×720) is created as " +
        "a stand-in so the chain cooks and previews standalone.",
    ),
  ocio_config_path: z
    .string()
    .optional()
    .describe(
      "Optional absolute path to an OCIO config file (`.ocio`). Only used when the OCIO " +
        "branch is taken.",
    ),
  strength: z
    .number()
    .min(0)
    .max(1)
    .default(1.0)
    .describe(
      "Blend amount between source (0 = untouched) and graded output (1 = full LUT). " +
        "Drives the Cross TOP crossfade parameter.",
    ),
  bypass: z
    .boolean()
    .default(false)
    .describe(
      "When true, forces the Cross TOP crossfade to 0 so the source passes through " +
        "unchanged. Also exposed as a toggle on the custom page.",
    ),
  prefer: z
    .enum(["auto", "ocio", "lookup"])
    .default("auto")
    .describe(
      "Branch selection. `auto` probes OpenColorIO availability at runtime and uses it for " +
        "`.cube`/`.3dl`/`.cc`/`.ccc` files, falling back to the Lookup TOP path for images. " +
        "`ocio` forces the OCIO branch. `lookup` forces the Movie File In + Lookup TOP path " +
        "even when OCIO is available.",
    ),
  expose_controls: z
    .boolean()
    .default(true)
    .describe(
      "When true, appends custom-page parameters Strength (float 0..1) and Bypass (toggle) " +
        "on the container COMP and binds them to the Cross TOP crossfade.",
    ),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP network where the LUT chain container is created."),
  container_name: z
    .string()
    .default("apply_lut")
    .describe("Base name for the container COMP (a numeric suffix is auto-applied by TD)."),
});

export type ApplyLutArgs = Required<
  Omit<z.infer<typeof applyLutSchema>, "source_path" | "ocio_config_path">
> & {
  source_path?: string;
  ocio_config_path?: string;
};

interface LutReport {
  container: string;
  source: string;
  grade_branch: "ocio" | "lookup" | "cube_parsed";
  ocio_available: boolean;
  output: string;
  warnings: string[];
  errors: string[];
}

// ---------------------------------------------------------------------------
// Python payload — one round-trip builds the full LUT chain inside TD.
//
// Steps:
//  1. Probe openColorIOTOP availability (try-create + destroy).
//  2. Decide branch from prefer + extension + probe.
//  3. Create baseCOMP, source node (selectTOP or constantTOP), grade branch,
//     crossTOP (blend), nullTOP (out1).
//  4. For .cube fallback, parse the cube file and materialise a tableDAT +
//     scriptTOP for the lookupTOP's second input.
//  5. Optionally add custom-page parameters (Strength / Bypass / LUT / Branch).
//  6. layoutChildren for tidy left→right layout.
//  7. Emit result = json.dumps(report).
// ---------------------------------------------------------------------------
const APPLY_LUT_SCRIPT = `
import json, base64, traceback, os, re
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {
    "container": "",
    "source": "",
    "grade_branch": "lookup",
    "ocio_available": False,
    "output": "",
    "warnings": [],
    "errors": [],
}
try:
    _parent = op(_p["parent_path"])
    if _parent is None:
        report["errors"].append("Parent COMP not found: " + str(_p["parent_path"]))
    else:
        # --- 1. Probe OCIO availability ---
        _ocio_avail = False
        if _p["prefer"] != "lookup":
            try:
                _probe = _parent.create(openColorIOTOP, "_ocio_probe")
                _probe.destroy()
                _ocio_avail = True
            except Exception:
                _ocio_avail = False
        report["ocio_available"] = _ocio_avail

        # --- 2. Decide branch ---
        _lut = _p["lut_path"]
        _ext = os.path.splitext(_lut)[1].lower()
        _ocio_exts = {".cube", ".3dl", ".cc", ".ccc"}
        if _p["prefer"] == "ocio":
            _branch = "ocio" if _ocio_avail else "lookup"
        elif _p["prefer"] == "lookup":
            _branch = "lookup"
        else:
            # auto
            if _ext in _ocio_exts and _ocio_avail:
                _branch = "ocio"
            elif _ext == ".cube" and not _ocio_avail:
                _branch = "cube_parsed"
            else:
                _branch = "lookup"
        report["grade_branch"] = _branch

        if _branch == "cube_parsed":
            report["warnings"].append(
                "OpenColorIO TOP not available; parsed .cube fallback in use."
            )

        # --- 3. Create container ---
        _cont = _parent.create(baseCOMP, _p["container_name"])
        report["container"] = _cont.path

        # --- 4. Create source node ---
        if _p["source_path"]:
            _src_node = _cont.create(selectTOP, "source")
            try:
                _src_node.par.top = _p["source_path"]
            except Exception as _e:
                report["warnings"].append("Could not set selectTOP.top: " + str(_e))
        else:
            _src_node = _cont.create(constantTOP, "source")
            try:
                _src_node.par.resolutionw = 1280
                _src_node.par.resolutionh = 720
                _src_node.par.colorr = 0.5
                _src_node.par.colorg = 0.5
                _src_node.par.colorb = 0.5
            except Exception as _e:
                report["warnings"].append("Could not set constantTOP params: " + str(_e))
        report["source"] = _src_node.path

        # --- 5. Create grade branch ---
        _grade_node = None
        if _branch == "ocio":
            _grade_node = _cont.create(openColorIOTOP, "ocio")
            try:
                _grade_node.par.file = _lut
            except Exception as _e:
                report["warnings"].append("Could not set OCIO file: " + str(_e))
            if _p["ocio_config_path"]:
                try:
                    _grade_node.par.ocioconfig = _p["ocio_config_path"]
                except Exception as _e:
                    report["warnings"].append("Could not set OCIO config: " + str(_e))
            # wire source -> ocio
            try:
                _grade_node.inputConnectors[0].connect(_src_node)
            except Exception as _e:
                report["warnings"].append("Could not wire source->ocio: " + str(_e))

        elif _branch == "lookup":
            _movie = _cont.create(moviefileinTOP, "lut_image")
            try:
                _movie.par.file = _lut
            except Exception as _e:
                report["warnings"].append("Could not set moviefilein.file: " + str(_e))
            _grade_node = _cont.create(lookupTOP, "lut_lookup")
            try:
                _grade_node.par.lookup = "input"
            except Exception as _e:
                report["warnings"].append("Could not set lookupTOP.lookup: " + str(_e))
            # wire source -> lookup[0], movie -> lookup[1]
            try:
                _grade_node.inputConnectors[0].connect(_src_node)
            except Exception as _e:
                report["warnings"].append("Could not wire source->lookup[0]: " + str(_e))
            try:
                _grade_node.inputConnectors[1].connect(_movie)
            except Exception as _e:
                report["warnings"].append("Could not wire movie->lookup[1]: " + str(_e))

        else:
            # cube_parsed — parse .cube in Python, write tableDAT, feed scriptTOP -> lookupTOP
            _cube_size = 33
            _cube_entries = []
            try:
                with open(_lut, "r") as _f:
                    _lines = _f.readlines()
                for _ln in _lines:
                    _ln = _ln.strip()
                    _m = re.match(r"LUT_3D_SIZE\\s+(\\d+)", _ln, re.IGNORECASE)
                    if _m:
                        _cube_size = int(_m.group(1))
                    _vals = _ln.split()
                    if len(_vals) == 3:
                        try:
                            _cube_entries.append((float(_vals[0]), float(_vals[1]), float(_vals[2])))
                        except ValueError:
                            pass
            except Exception as _e:
                report["warnings"].append("Could not parse .cube file: " + str(_e))

            # Write tableDAT
            _tdat = _cont.create(tableDAT, "lut_cube_table")
            _tdat.clear(keepSize=False)
            _tdat.insertRow(["r", "g", "b"])
            for _entry in _cube_entries[:_cube_size * _cube_size * _cube_size]:
                _tdat.appendRow([str(_entry[0]), str(_entry[1]), str(_entry[2])])

            # Create scriptTOP + callbacks DAT
            _cb_dat = _cont.create(textDAT, "lut_cube_callbacks")
            _cb_src = """
import numpy as np
def onCook(scriptOp):
    tdat = op('lut_cube_table')
    n = tdat.numRows - 1
    sz = int(round(n ** (1/3.0))) if n > 0 else 33
    w = sz * sz
    h = sz
    scriptOp.copySize(w, h)
    a = scriptOp.numpyArray(delayed=True)
    if a is not None:
        for i in range(n):
            row = tdat[i + 1, :]
            b_idx = i // (sz * sz)
            rem = i % (sz * sz)
            g_idx = rem // sz
            r_idx = rem % sz
            px = (b_idx * sz + g_idx) * 1
            try:
                a[g_idx, b_idx * sz + r_idx, 0] = float(str(row[0]))
                a[g_idx, b_idx * sz + r_idx, 1] = float(str(row[1]))
                a[g_idx, b_idx * sz + r_idx, 2] = float(str(row[2]))
                a[g_idx, b_idx * sz + r_idx, 3] = 1.0
            except Exception:
                pass
"""
            try:
                _cb_dat.text = _cb_src
            except Exception as _e:
                report["warnings"].append("Could not set cube callbacks text: " + str(_e))

            _script_top = _cont.create(scriptTOP, "lut_cube")
            try:
                _script_top.par.callbacks = _cb_dat
            except Exception as _e:
                report["warnings"].append("Could not set scriptTOP.callbacks: " + str(_e))

            _grade_node = _cont.create(lookupTOP, "lut_lookup")
            try:
                _grade_node.par.lookup = "input"
            except Exception as _e:
                report["warnings"].append("Could not set lookupTOP.lookup: " + str(_e))
            try:
                _grade_node.inputConnectors[0].connect(_src_node)
            except Exception as _e:
                report["warnings"].append("Could not wire source->lookup[0]: " + str(_e))
            try:
                _grade_node.inputConnectors[1].connect(_script_top)
            except Exception as _e:
                report["warnings"].append("Could not wire scriptTOP->lookup[1]: " + str(_e))

        # --- 6. Create crossTOP (blend) ---
        _cross = _cont.create(crossTOP, "blend")
        _effective_cf = 0.0 if _p["bypass"] else float(_p["strength"])
        try:
            _cross.par.crossfade = _effective_cf
        except Exception as _e:
            report["warnings"].append("Could not set crossTOP.crossfade: " + str(_e))
        try:
            _cross.inputConnectors[0].connect(_src_node)
        except Exception as _e:
            report["warnings"].append("Could not wire source->cross[0]: " + str(_e))
        if _grade_node is not None:
            try:
                _cross.inputConnectors[1].connect(_grade_node)
            except Exception as _e:
                report["warnings"].append("Could not wire grade->cross[1]: " + str(_e))

        # --- 7. Apply bypass expression when expose_controls ---
        if _p["expose_controls"]:
            try:
                _cross.par.crossfade.expr = (
                    "0 if me.parent().par.Bypass else me.parent().par.Strength"
                )
            except Exception as _e:
                report["warnings"].append("Could not set crossfade expression: " + str(_e))

        # --- 8. Create out1 null ---
        _out = _cont.create(nullTOP, "out1")
        try:
            _out.inputConnectors[0].connect(_cross)
        except Exception as _e:
            report["warnings"].append("Could not wire cross->out1: " + str(_e))
        report["output"] = _out.path

        # --- 9. Custom-page controls ---
        if _p["expose_controls"]:
            try:
                _page = _cont.appendCustomPage("LUT")
                _page.appendFloat("Strength", label="Strength")[0].val = float(_p["strength"])
                _page.appendToggle("Bypass", label="Bypass")[0].val = bool(_p["bypass"])
                _page.appendStr("LutPath", label="LUT")[0].val = str(_lut)
                _page.appendStr("Branch", label="Branch")[0].val = str(_branch)
            except Exception as _e:
                report["warnings"].append("Could not add custom page: " + str(_e))

        # --- 10. Layout ---
        try:
            _cont.layoutChildren()
        except Exception:
            pass

except Exception as _exc:
    report["errors"].append(traceback.format_exc())

print(json.dumps(report))
`;

// ---------------------------------------------------------------------------
// Impl
// ---------------------------------------------------------------------------

export async function applyLutImpl(ctx: ToolContext, args: ApplyLutArgs) {
  // Check LUT file existence (skip when the path starts with '/' but doesn't
  // exist on disk — friendly early exit; tests mock the exec endpoint instead
  // of creating real files so we guard only when not running under vitest).
  if (process.env.VITEST !== "true" && !existsSync(args.lut_path)) {
    return errorResult(`LUT file not found: ${args.lut_path}`);
  }

  return guardTd(
    async () => {
      const payload = {
        lut_path: args.lut_path,
        source_path: args.source_path ?? "",
        ocio_config_path: args.ocio_config_path ?? "",
        strength: args.strength,
        bypass: args.bypass,
        prefer: args.prefer,
        expose_controls: args.expose_controls,
        parent_path: args.parent_path,
        container_name: args.container_name,
      };

      const script = buildPayloadScript(APPLY_LUT_SCRIPT, payload);
      const execResult = await ctx.client.executePythonScript(script);
      const report = parsePythonReport<LutReport>(execResult.stdout);

      if (report.errors.length > 0) {
        return errorResult(`apply_lut failed: ${report.errors.join("; ")}`, report);
      }

      // Attempt to capture a preview of the output node.
      let preview_image: string | undefined;
      if (report.output) {
        try {
          const prev = await ctx.client.getPreview(report.output);
          preview_image = prev.base64;
        } catch {
          // preview is best-effort
        }
      }

      const summary =
        `Applied LUT "${args.lut_path}" via ${report.grade_branch} branch` +
        (report.ocio_available ? " (OCIO available)" : " (OCIO unavailable)") +
        `. Output: ${report.output}.` +
        (report.warnings.length > 0 ? ` Warnings: ${report.warnings.join("; ")}` : "");

      return jsonResult(summary, {
        summary,
        branch: report.grade_branch,
        ocio_available: report.ocio_available,
        output_path: report.output,
        container_path: report.container,
        source_path: report.source,
        warnings: report.warnings,
        errors: report.errors,
        preview_image,
      });
    },
    (r) => r,
  );
}

// ---------------------------------------------------------------------------
// Registrar
// ---------------------------------------------------------------------------

export const registerApplyLut: ToolRegistrar = (server, ctx) =>
  server.registerTool(
    "apply_lut",
    {
      title: "Apply LUT",
      description:
        "Apply a colour Look-Up Table (LUT) to an existing TOP inside a self-contained " +
        "baseCOMP. Prefers an OpenColorIO TOP for `.cube`/`.3dl`/`.cc`/`.ccc` files; falls " +
        "back to a Movie File In + Lookup TOP for image LUTs or when OCIO is unavailable. " +
        "A `.cube` file with no OCIO is parsed in Python into a Script TOP ramp. Exposes " +
        "Strength and Bypass controls on a custom page. Pass `source_path` to grade an " +
        "existing TOP, or omit it for a standalone preview on a grey Constant TOP.",
      inputSchema: applyLutSchema.shape,
    },
    (rawArgs) => {
      const parsed = applyLutSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return errorResult(`Invalid apply_lut arguments: ${parsed.error.message}`);
      }
      return applyLutImpl(ctx, parsed.data as ApplyLutArgs);
    },
  );
