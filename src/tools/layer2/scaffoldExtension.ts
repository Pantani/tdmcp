import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const scaffoldExtensionSchema = z.object({
  comp_path: z
    .string()
    .describe(
      "The COMP to make scriptable, e.g. '/project1/myWidget'. An extension class DAT is created inside it and pointed to by the COMP's extension parameters.",
    ),
  class_name: z
    .string()
    .min(1)
    .describe(
      "Python class name for the extension, conventionally capitalized (e.g. 'WidgetExt'). The first letter is auto-capitalized; the rest is kept as given.",
    ),
  methods: z
    .array(z.string())
    .optional()
    .describe(
      "Names of stub methods to pre-generate inside the class. Each becomes a 'def name(self):' with a docstring + 'return'. Omit or leave empty to generate only '__init__'.",
    ),
  promote: z
    .boolean()
    .default(true)
    .describe(
      "Promote extension members so they are accessible directly on the COMP as 'comp.<method>()' in addition to 'comp.ext.<Class>.<method>()'.",
    ),
  slot: z.coerce
    .number()
    .int()
    .min(1)
    .max(8)
    .default(1)
    .describe(
      "Which extension slot (1–8) to use. Most COMPs only need slot 1. Each slot has its own Object and Promote parameters.",
    ),
});

export type ScaffoldExtensionArgs = z.infer<typeof scaffoldExtensionSchema>;

interface ExtensionReport {
  comp: string;
  class_name: string;
  dat: string | null;
  extension_par: string | null;
  promote_par: string | null;
  promoted: boolean | null;
  reinit: boolean;
  warnings: string[];
  fatal?: string;
}

// One Python pass: create the Text DAT, write the class source, probe and set
// the extension/promote pars by name, then pulse reinitextensions. All TD globals
// live inside this template; the payload travels as base64.
//
// Par-name probing strategy: TD uses `extension{N}` for the Object expression and
// `promoteextension{N}` for the Promote toggle. We probe `_comp.pars('*xtension*')`
// so the real names are discovered live (they vary by build) rather than hardcoded.
// If a name is not found we append a warning and skip that step (fail-forward).
const EXTENSION_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {
    "comp": _p["comp"],
    "class_name": _p["class_name"],
    "dat": None,
    "extension_par": None,
    "promote_par": None,
    "promoted": None,
    "reinit": False,
    "warnings": [],
}
try:
    _comp = op(_p["comp"])
    if _comp is None:
        report["fatal"] = "COMP not found: " + str(_p["comp"])
    elif not _comp.isCOMP:
        report["fatal"] = str(_p["comp"]) + " is not a COMP, so it cannot hold an extension."
    else:
        _cls = _p["class_name"]
        _slot = int(_p.get("slot", 1))
        _methods = _p.get("methods") or []

        # Build the class source text
        _lines = [
            "class " + _cls + ":",
            "    def __init__(self, ownerComp):",
            "        self.ownerComp = ownerComp",
        ]
        for _m in _methods:
            _lines.append("    def " + _m + "(self):")
            _lines.append('        """TODO: implement."""')
            _lines.append("        return")
        _src = "\\n".join(_lines) + "\\n"

        # Create or reuse the Text DAT inside _comp
        _dat = _comp.op(_cls) or _comp.create(textDAT, _cls)
        _dat.text = _src
        report["dat"] = _dat.path

        # Probe extension par names for this slot.
        # Expected: extension{N} (Object expr) and promoteextension{N} (Promote toggle).
        # We search case-insensitively for pars containing "xtension" then filter by slot suffix.
        _all_par_names = [pp.name for pp in _comp.pars()]
        report["warnings"].append("discovered_pars: " + str(_all_par_names))

        _ext_par_name = "extension" + str(_slot)
        _prm_par_name = "promoteextension" + str(_slot)
        _reinit_par_name = "reinitextensions"

        _ext_par = getattr(_comp.par, _ext_par_name, None)
        _prm_par = getattr(_comp.par, _prm_par_name, None)
        _reinit_par = getattr(_comp.par, _reinit_par_name, None)

        if _ext_par is None:
            # Try case-insensitive search among known pars
            _lc = _ext_par_name.lower()
            _candidates = [n for n in _all_par_names if n.lower() == _lc]
            if _candidates:
                _ext_par = getattr(_comp.par, _candidates[0], None)
                _ext_par_name = _candidates[0]
            else:
                report["warnings"].append(
                    "Extension Object par not found for slot " + str(_slot) +
                    "; looked for '" + _ext_par_name + "'. Available pars: " + str(_all_par_names)
                )

        if _prm_par is None:
            _lc2 = _prm_par_name.lower()
            _candidates2 = [n for n in _all_par_names if n.lower() == _lc2]
            if _candidates2:
                _prm_par = getattr(_comp.par, _candidates2[0], None)
                _prm_par_name = _candidates2[0]
            else:
                report["warnings"].append(
                    "Extension Promote par not found for slot " + str(_slot) +
                    "; looked for '" + _prm_par_name + "'. Available pars: " + str(_all_par_names)
                )

        # Set extension Object par to op('./<DAT>').module.<Class>(me). The DAT is a child
        # named after the class, so the './' relative path resolves it from the COMP's context.
        # (The mod('<Class>') form does NOT resolve a child DAT on current builds — verified live —
        # so it would leave comp.ext.<Class> unavailable.)
        if _ext_par is not None:
            try:
                _ext_par.val = "op('./" + _cls + "').module." + _cls + "(me)"
                report["extension_par"] = _ext_par_name
            except Exception:
                report["warnings"].append(
                    "Could not set " + _ext_par_name + ": " + traceback.format_exc().splitlines()[-1]
                )

        # Set Promote par
        if _prm_par is not None:
            try:
                _prm_par.val = bool(_p.get("promote", True))
                report["promote_par"] = _prm_par_name
                report["promoted"] = bool(_prm_par.eval())
            except Exception:
                report["warnings"].append(
                    "Could not set " + _prm_par_name + ": " + traceback.format_exc().splitlines()[-1]
                )

        # Pulse reinitextensions
        if _reinit_par is not None:
            try:
                _reinit_par.pulse()
                report["reinit"] = True
            except Exception:
                report["warnings"].append(
                    "Could not pulse reinitextensions: " + traceback.format_exc().splitlines()[-1]
                )
        else:
            _reinit_candidates = [n for n in _all_par_names if "reinit" in n.lower()]
            report["warnings"].append(
                "reinitextensions par not found. Candidates: " + str(_reinit_candidates)
            )

        # Remove the diagnostic par-list warning if everything went fine
        # (keep it only when something was missing so a human/lead can diagnose)
        _had_issues = (
            report["extension_par"] is None or
            report["promote_par"] is None or
            not report["reinit"]
        )
        if not _had_issues:
            report["warnings"] = [w for w in report["warnings"] if not w.startswith("discovered_pars:")]

except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildScaffoldExtensionScript(payload: object): string {
  return buildPayloadScript(EXTENSION_SCRIPT, payload);
}

export async function scaffoldExtensionImpl(ctx: ToolContext, args: ScaffoldExtensionArgs) {
  // Auto-capitalize the first letter of class_name, keep the rest as given.
  const className = args.class_name.charAt(0).toUpperCase() + args.class_name.slice(1);

  return guardTd(
    async () => {
      const script = buildScaffoldExtensionScript({
        comp: args.comp_path,
        class_name: className,
        methods: args.methods ?? [],
        promote: args.promote,
        slot: args.slot,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<ExtensionReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`scaffold_extension failed: ${report.fatal}`, report);
      }
      const warnCount = report.warnings.length;
      const parts: string[] = [
        `Scaffolded extension ${report.class_name} on ${report.comp}`,
        `(DAT ${report.dat ?? "unknown"})`,
        `promote=${String(report.promoted ?? args.promote)}`,
        report.reinit ? "re-init pulsed" : "re-init NOT pulsed (par not found)",
      ];
      if (warnCount > 0) {
        parts.push(`${warnCount} warning(s)`);
      }
      return jsonResult(`${parts.join(", ")}.`, report);
    },
  );
}

export const registerScaffoldExtension: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "scaffold_extension",
    {
      title: "Scaffold extension class",
      description:
        "Make a COMP scriptable by creating a Text DAT holding a Python extension class, pointing the COMP's Extension Object parameter at it (via op('./<DAT>').module.<Class>(me)), setting the Promote flag, and re-initing extensions. 'comp.ext.<Class>.<method>()' works immediately. The Promote flag is set so the direct 'comp.<method>()' shorthand resolves once TouchDesigner re-initializes extensions through its normal lifecycle (project reload or the UI 'Re-Init Extensions' action) — scripted promotion doesn't always take effect in the same session.",
      inputSchema: scaffoldExtensionSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => scaffoldExtensionImpl(ctx, args),
  );
};
