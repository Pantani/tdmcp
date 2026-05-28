import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const scaffoldExtensionSchema = z.object({
  comp_path: z.string().describe("The COMP to give a Python extension class."),
  class_name: z
    .string()
    .describe(
      "Extension class name, e.g. 'WidgetExt' (sanitized to a valid, capitalized identifier).",
    ),
  methods: z
    .array(z.string())
    .optional()
    .describe("Optional method-name stubs to add to the class (each takes only `self`)."),
  promote: z
    .boolean()
    .default(true)
    .describe(
      "Promote the extension so its members are callable directly on the COMP (op.Method()).",
    ),
  slot: z.coerce
    .number()
    .int()
    .min(1)
    .max(8)
    .default(1)
    .describe("Extension slot (1–8) — a COMP can hold several extensions."),
});
type ScaffoldExtensionArgs = z.infer<typeof scaffoldExtensionSchema>;

interface ExtensionReport {
  comp: string;
  dat?: string;
  extension?: string;
  promoted?: boolean;
  methods: string[];
  warnings: string[];
  fatal?: string;
}

/** Sanitize to a valid, capitalized Python class identifier (empty if nothing usable). */
function toClassName(raw: string): string {
  let s = raw.replace(/[^A-Za-z0-9_]/g, "");
  if (!s) return "";
  if (!/[A-Za-z_]/.test(s[0] ?? "")) s = `C${s}`;
  return (s[0] ?? "").toUpperCase() + s.slice(1);
}

/** Sanitize to a valid Python method identifier (empty if nothing usable). */
function toMethodName(raw: string): string {
  let s = raw.replace(/[^A-Za-z0-9_]/g, "");
  if (!s) return "";
  if (/[0-9]/.test(s[0] ?? "")) s = `m${s}`;
  return s;
}

/** Build the extension class source (PEP8-ish 4-space indent) from the class + method names. */
export function buildClassSource(className: string, methods: string[]): string {
  const lines = [
    `class ${className}:`,
    "    def __init__(self, ownerComp):",
    "        self.ownerComp = ownerComp",
  ];
  for (const m of methods) {
    lines.push("", `    def ${m}(self):`, "        pass");
  }
  return `${lines.join("\n")}\n`;
}

// An extension is a Text DAT holding a Python class plus a few parameters on the
// COMP's built-in "Extensions" page. Current builds name those parameters with a
// zero-based sequence ("ext0object" / "ext0promote" for the first slot — also what
// this repo's *_comp.json metadata records), while older builds used the one-based
// "extension1" / "promoteextension1"; "reinitextensions" is the refresh pulse on
// both. The script tries BOTH naming schemes (exact), then a fuzzy fallback, and
// only warns when it had to fall back — rather than hardcoding one scheme and
// silently failing on the other (which would leave the COMP unwired but "ok").
const EXTENSION_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"comp": _p["comp"], "methods": _p["methods"], "warnings": []}
_comp = op(_p["comp"])

def _find(comp, exacts, contains_all, exclude=()):
    for _ex in exacts:
        _pe = getattr(comp.par, _ex, None)
        if _pe is not None:
            return _pe
    try:
        _all = comp.pars("*")
    except Exception:
        _all = []
    for _pp in _all:
        _ln = _pp.name.lower()
        if all(t in _ln for t in contains_all) and not any(x in _ln for x in exclude):
            return _pp
    return None

try:
    if _comp is None:
        report["fatal"] = "COMP not found: " + _p["comp"]
    elif not _comp.isCOMP:
        report["fatal"] = _p["comp"] + " is not a COMP, so it cannot hold an extension."
    else:
        _cname = _p["class_name"]; _slot = _p["slot"]; _idx = _slot - 1
        _dat = _comp.op(_cname)
        if _dat is not None and not _dat.isDAT:
            report["fatal"] = "A non-DAT named '%s' already exists in %s." % (_cname, _p["comp"])
        else:
            if _dat is None:
                _dat = _comp.create(textDAT, _cname)
            _dat.text = _p["code"]
            report["dat"] = _dat.path
            # Extension expression par: zero-based "ext0object" on current builds,
            # one-based "extension1" on legacy ones. Try both, then fuzzy-match.
            _ext_cands = ["ext%dobject" % _idx, "extension%d" % _slot]
            _extp = _find(_comp, _ext_cands, ["ext", "object"], exclude=("promote", "name", "reinit"))
            if _extp is not None:
                _extp.val = _p["extension"]
                report["extension"] = _p["extension"]
                if _extp.name not in _ext_cands:
                    report["warnings"].append("Used '%s' for the extension slot (build names differ from %s)." % (_extp.name, _ext_cands))
            else:
                report["warnings"].append("Could not find an extension parameter for slot %s on %s." % (_slot, _p["comp"]))
            # Promote flag: "ext0promote" (current) / "promoteextension1" (legacy).
            _prom_cands = ["ext%dpromote" % _idx, "promoteextension%d" % _slot]
            _promp = _find(_comp, _prom_cands, ["ext", "promote"])
            if _promp is not None:
                _promp.val = bool(_p["promote"])
                report["promoted"] = bool(_p["promote"])
                if _promp.name not in _prom_cands:
                    report["warnings"].append("Used '%s' to set promotion (build names differ from %s)." % (_promp.name, _prom_cands))
            else:
                report["promoted"] = False
                report["warnings"].append("Could not find a promote-extension parameter for slot %s." % _slot)
            _reinit = _find(_comp, ["reinitextensions", "reinitextensionspulse"], ["reinit", "ext"], exclude=("promote",))
            if _reinit is not None:
                try:
                    _reinit.pulse()
                except Exception:
                    report["warnings"].append("reinitextensions did not pulse cleanly: " + traceback.format_exc().splitlines()[-1])
            else:
                report["warnings"].append("Could not find reinitextensions to refresh the extension.")
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildExtensionScript(payload: object): string {
  return buildPayloadScript(EXTENSION_SCRIPT, payload);
}

export async function scaffoldExtensionImpl(ctx: ToolContext, args: ScaffoldExtensionArgs) {
  const className = toClassName(args.class_name);
  if (!className) {
    return errorResult(
      `'${args.class_name}' has no usable letters/digits for a Python class name.`,
    );
  }
  // Dedupe + drop unusable method names; a bad name should not abort the scaffold.
  const seen = new Set<string>();
  const methods: string[] = [];
  for (const m of args.methods ?? []) {
    const name = toMethodName(m);
    if (name && !seen.has(name)) {
      seen.add(name);
      methods.push(name);
    }
  }
  const code = buildClassSource(className, methods);
  // The Text DAT is a *child* of the COMP, so the expression must scope the search
  // to the COMP's own children with `op('./<DAT>')` — bare `op('<DAT>')` / `mod(...)`
  // search upward through parents and resolve to None (verified live in TD 2025).
  const extension = `op('./${className}').module.${className}(me)`;
  return guardTd(
    async () => {
      const script = buildExtensionScript({
        comp: args.comp_path,
        class_name: className,
        code,
        extension,
        promote: args.promote,
        slot: args.slot,
        methods,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<ExtensionReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`Could not scaffold extension: ${report.fatal}`, report);
      }
      const summary = `Scaffolded extension ${className} on ${report.comp}${
        report.dat ? ` (DAT ${report.dat})` : ""
      }${report.promoted ? ", promoted" : ""}${
        report.methods.length ? `, ${report.methods.length} method stub(s)` : ""
      }${report.warnings.length ? `, ${report.warnings.length} warning(s)` : ""}.`;
      return jsonResult(summary, report);
    },
  );
}

export const registerScaffoldExtension: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "scaffold_extension",
    {
      title: "Scaffold extension class",
      description:
        "Give a COMP a Python extension class: create a Text DAT holding the class (with optional method stubs), wire it into an extension slot, optionally promote it (so members are callable directly on the COMP), and reinitialize. The other half of making a generated network reusable — pair with `add_custom_parameters` (knobs) and `manage_component` (save as .tox).",
      inputSchema: scaffoldExtensionSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => scaffoldExtensionImpl(ctx, args),
  );
};
