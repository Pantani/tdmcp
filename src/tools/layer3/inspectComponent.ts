import { z } from "zod";
import { isMissingEndpoint } from "../../td-client/types.js";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

export const inspectComponentSchema = z.object({
  path: z.string().describe("COMP to inspect."),
  include_storage: z
    .boolean()
    .default(true)
    .describe("Include the COMP's Python storage dict (keys + JSON-able values)."),
  include_extensions: z
    .boolean()
    .default(true)
    .describe("Include extension classes + promoted members."),
  include_custom_pars: z
    .boolean()
    .default(true)
    .describe("Include custom-parameter definitions (page/name/style/default)."),
});
type InspectComponentArgs = z.infer<typeof inspectComponentSchema>;

// ---------------------------------------------------------------------------
// Output schema (structuredResult + outputSchema — this is a READ tool)
// ---------------------------------------------------------------------------

export const inspectComponentOutputSchema = z.object({
  path: z.string().describe("Full path of the inspected COMP."),
  type: z.string().describe("Operator type of the COMP (e.g. 'baseCOMP')."),
  storage: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Python storage dict — keys and their JSON-serializable values (non-serializable values are stringified).",
    ),
  extensions: z
    .array(
      z.object({
        name: z.string().describe("Extension class name as registered on the COMP."),
        promoted: z
          .boolean()
          .describe("Whether the extension's members are promoted onto the COMP."),
        members: z
          .array(z.string())
          .describe("Public (non-dunder) member names on the extension object (capped at 50)."),
      }),
    )
    .optional()
    .describe("Extension class descriptors attached to the COMP."),
  custom_pars: z
    .array(
      z.object({
        page: z.string().describe("Custom-parameter page name."),
        name: z.string().describe("Parameter name."),
        style: z
          .string()
          .describe("Parameter style / widget type (e.g. 'Float', 'Toggle', 'Menu')."),
        default: z.unknown().optional().describe("Default value, if readable."),
      }),
    )
    .optional()
    .describe("Custom-parameter definitions on the COMP, across all custom pages."),
  probe: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "API-reachability map from the bridge — records which storage/extension/custom-par APIs were available on this TD build. UNVERIFIED: exact attribute names vary by build.",
    ),
  warnings: z.array(z.string()).describe("Per-item problems that did not abort the inspection."),
});

// ---------------------------------------------------------------------------
// Report interface (bridge → TS)
// ---------------------------------------------------------------------------

interface ExtensionEntry {
  name: string;
  promoted: boolean;
  members: string[];
}

interface CustomParEntry {
  page: string;
  name: string;
  style: string;
  default?: unknown;
}

interface InspectComponentReport {
  path: string;
  type: string;
  storage?: Record<string, unknown>;
  extensions?: ExtensionEntry[];
  custom_pars?: CustomParEntry[];
  probe?: Record<string, unknown>;
  warnings: string[];
  fatal?: string;
}

// ---------------------------------------------------------------------------
// Bridge script (ONE pass, fully defensive / probe-first)
//
// UNVERIFIED: the following TD Python APIs vary by build and have never been
// confirmed live in this environment. The script probes each before using it
// and records the result in report["probe"] so callers can reason about gaps.
//
// - op.storage         — dict attribute; present on COMP in TD 2022.x+
// - op.extensions      — list of ext-info objects; name/promote varies
// - op.ext             — namespace proxy (ext.ClassName); promoted flag unclear
// - op.customPars      — list of Par objects; par.page.name / par.style read
// - par.style          — string like "Float", "Toggle"; may not exist pre-2021
//
// The script always writes report["probe"] so the TS side can surface gaps.
// ---------------------------------------------------------------------------

const INSPECT_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {
    "path": _p["path"],
    "type": "",
    "warnings": [],
    "probe": {}
}
try:
    _c = op(_p["path"])
    if _c is None:
        report["fatal"] = "Not found: " + _p["path"]
    elif not getattr(_c, "isCOMP", False):
        report["fatal"] = _p["path"] + " is not a COMP."
    else:
        report["type"] = getattr(_c, "type", "unknown")

        # --- storage ---
        if _p["include_storage"]:
            try:
                _raw = getattr(_c, "storage", None)
                report["probe"]["storage_attr"] = "storage" if _raw is not None else "missing"
                if _raw is not None and isinstance(_raw, dict):
                    _ser = {}
                    for _k, _v in _raw.items():
                        try:
                            json.dumps(_v)
                            _ser[str(_k)] = _v
                        except Exception:
                            _ser[str(_k)] = str(_v)
                            report["warnings"].append("storage key '%s': value not JSON-serializable, stored as string." % str(_k))
                    report["storage"] = _ser
                elif _raw is not None:
                    report["warnings"].append("storage attr exists but is not a dict (type=%s); skipped." % type(_raw).__name__)
                    report["storage"] = {}
                else:
                    report["storage"] = {}
            except Exception:
                report["warnings"].append("storage read error: " + traceback.format_exc().splitlines()[-1])
                report["storage"] = {}

        # --- extensions ---
        if _p["include_extensions"]:
            _ext_list = []
            try:
                # UNVERIFIED probe order for the extensions list attribute:
                # TD 2022.x added op.extensions as a list of ext-info objects;
                # earlier builds may expose op.ext as a namespace only (no list).
                _exts_raw = getattr(_c, "extensions", None)
                report["probe"]["extensions_attr"] = "extensions" if _exts_raw is not None else "missing"
                if _exts_raw is not None and isinstance(_exts_raw, (list, tuple)):
                    report["probe"]["extensions_is_list"] = True
                    for _idx, _ext in enumerate(_exts_raw):
                        try:
                            # Extension info object — probe name/promote fields.
                            # TD 2022+: ext object has .object (the class instance) and .name.
                            _ext_obj = getattr(_ext, "object", _ext)
                            _ext_name = getattr(_ext, "name", None) or type(_ext_obj).__name__
                            # Promoted flag: check ext.promote (current) then par promote.
                            _promoted = bool(getattr(_ext, "promote", False))
                            report["probe"]["ext%d_promote_attr" % _idx] = "promote" if hasattr(_ext, "promote") else "missing"
                            # Public members on the ext object (cap at 50).
                            try:
                                _members = [m for m in dir(_ext_obj) if not m.startswith("_")][:50]
                            except Exception:
                                _members = []
                            _ext_list.append({
                                "name": str(_ext_name),
                                "promoted": _promoted,
                                "members": _members,
                            })
                        except Exception:
                            report["warnings"].append("extension[%d] read error: %s" % (_idx, traceback.format_exc().splitlines()[-1]))
                else:
                    # Fallback: probe op.ext namespace for any named ext classes.
                    _ext_ns = getattr(_c, "ext", None)
                    report["probe"]["ext_ns_attr"] = "ext" if _ext_ns is not None else "missing"
                    if _ext_ns is not None:
                        try:
                            for _mname in [m for m in dir(_ext_ns) if not m.startswith("_")]:
                                try:
                                    _ext_obj = getattr(_ext_ns, _mname)
                                    _members = [m for m in dir(_ext_obj) if not m.startswith("_")][:50]
                                    _ext_list.append({
                                        "name": _mname,
                                        "promoted": True,
                                        "members": _members,
                                    })
                                except Exception:
                                    report["warnings"].append("ext.%s read error: %s" % (_mname, traceback.format_exc().splitlines()[-1]))
                        except Exception:
                            report["warnings"].append("ext namespace iteration error: " + traceback.format_exc().splitlines()[-1])
                    else:
                        report["warnings"].append("No extensions list or ext namespace found on this COMP.")
            except Exception:
                report["warnings"].append("extensions section error: " + traceback.format_exc().splitlines()[-1])
            report["extensions"] = _ext_list

        # --- custom parameters ---
        # When the TS layer is going to fill custom_pars via the REST endpoint
        # GET /api/nodes/<path>/custom_params, it sets skip_custom_in_script=true
        # so the script omits the readout. The TS side falls back to running the
        # script with skip_custom_in_script=false when the endpoint is missing
        # on an older bridge so the output stays identical pre/post promotion.
        _skip_custom = bool(_p.get("skip_custom_in_script", False))
        if _p["include_custom_pars"] and not _skip_custom:
            _par_list = []
            try:
                # Probe for customPars (list of custom Par objects across all pages).
                _cp = getattr(_c, "customPars", None)
                report["probe"]["customPars_attr"] = "customPars" if _cp is not None else "missing"
                if _cp is not None:
                    for _par in _cp:
                        try:
                            # par.page is a Page object; par.page.name is the page name string.
                            _page = "unknown"
                            try:
                                _page = str(_par.page.name)
                                report["probe"]["par_page_name"] = "ok"
                            except Exception:
                                report["probe"]["par_page_name"] = "error"
                                report["warnings"].append("par.page.name read failed for '%s'." % getattr(_par, "name", "?"))
                            _pname = str(getattr(_par, "name", "?"))
                            # par.style is a string like "Float", "Toggle", etc.
                            _style = "unknown"
                            try:
                                _style = str(_par.style)
                                report["probe"]["par_style"] = "ok"
                            except Exception:
                                report["probe"]["par_style"] = "error"
                            # Default value — read par.default defensively.
                            _dflt = None
                            try:
                                _dflt_raw = _par.default
                                json.dumps(_dflt_raw)
                                _dflt = _dflt_raw
                                report["probe"]["par_default"] = "ok"
                            except Exception:
                                try:
                                    _dflt = str(_par.default)
                                except Exception:
                                    _dflt = None
                            _entry = {"page": _page, "name": _pname, "style": _style}
                            if _dflt is not None:
                                _entry["default"] = _dflt
                            _par_list.append(_entry)
                        except Exception:
                            report["warnings"].append("custom par read error: " + traceback.format_exc().splitlines()[-1])
                else:
                    # Fallback: iterate customPages and gather pars per page.
                    _pages = getattr(_c, "customPages", None)
                    report["probe"]["customPages_attr"] = "customPages" if _pages is not None else "missing"
                    if _pages is not None:
                        for _pg in _pages:
                            try:
                                _pg_name = str(getattr(_pg, "name", "?"))
                                for _par in getattr(_pg, "pars", []):
                                    try:
                                        _pname = str(getattr(_par, "name", "?"))
                                        _style = "unknown"
                                        try:
                                            _style = str(_par.style)
                                        except Exception:
                                            pass
                                        _dflt = None
                                        try:
                                            _dflt_raw = _par.default
                                            json.dumps(_dflt_raw)
                                            _dflt = _dflt_raw
                                        except Exception:
                                            try:
                                                _dflt = str(_par.default)
                                            except Exception:
                                                pass
                                        _entry = {"page": _pg_name, "name": _pname, "style": _style}
                                        if _dflt is not None:
                                            _entry["default"] = _dflt
                                        _par_list.append(_entry)
                                    except Exception:
                                        report["warnings"].append("custom par (page) read error: " + traceback.format_exc().splitlines()[-1])
                            except Exception:
                                report["warnings"].append("custom page read error: " + traceback.format_exc().splitlines()[-1])
                    else:
                        report["warnings"].append("No customPars or customPages attribute found on this COMP.")
            except Exception:
                report["warnings"].append("custom_pars section error: " + traceback.format_exc().splitlines()[-1])
            report["custom_pars"] = _par_list

except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildInspectScript(payload: object): string {
  return buildPayloadScript(INSPECT_SCRIPT, payload);
}

// ---------------------------------------------------------------------------
// Impl
// ---------------------------------------------------------------------------

/** Run the exec script with a given `skip_custom_in_script` flag and parse it. */
async function runInspectExec(
  ctx: ToolContext,
  args: InspectComponentArgs,
  skipCustomInScript: boolean,
): Promise<InspectComponentReport> {
  const script = buildInspectScript({
    path: args.path,
    include_storage: args.include_storage,
    include_extensions: args.include_extensions,
    include_custom_pars: args.include_custom_pars,
    skip_custom_in_script: skipCustomInScript,
  });
  const exec = await ctx.client.executePythonScript(script, true);
  return parsePythonReport<InspectComponentReport>(exec.stdout);
}

export async function inspectComponentImpl(ctx: ToolContext, args: InspectComponentArgs) {
  return guardTd(
    async () => {
      // PROMOTION (partial): for `custom_pars` ONLY we prefer the first-class
      // REST endpoint GET /api/nodes/<path>/custom_params (wave-7). Storage,
      // extensions, and the probe map still ride the exec script — no first-
      // class endpoint covers them. So we:
      //   1) run the exec script with `skip_custom_in_script=true` to get
      //      storage + extensions + type + probe (no custom_pars), then
      //   2) fetch custom_pars via the REST endpoint and map its
      //      `name/page/style/default` onto the existing CustomParEntry shape
      //      (label/value/min/max/options are dropped because the public
      //      inspect contract is page/name/style/default only).
      //   3) On missing endpoint (older bridge), fall back to a SECOND exec
      //      with the legacy in-script readout so the output is identical to
      //      the pre-promotion behaviour.
      if (!args.include_custom_pars) {
        return runInspectExec(ctx, args, false);
      }
      const report = await runInspectExec(ctx, args, true);
      if (report.fatal) return report;
      try {
        const rest = await ctx.client.getCustomParams(args.path);
        if (!report.probe) report.probe = {};
        report.probe.custom_params_endpoint = "ok";
        if (rest.warnings.length > 0) {
          for (const w of rest.warnings) {
            report.warnings.push(`custom_params: ${w}`);
          }
        }
        if (rest.fatal) {
          report.warnings.push(`custom_params: ${rest.fatal}`);
        }
        const mapped: CustomParEntry[] = rest.params.map((p) => {
          const entry: CustomParEntry = {
            page: p.page ?? "unknown",
            name: p.name,
            style: p.style ?? "unknown",
          };
          if (p.default !== undefined) entry.default = p.default;
          return entry;
        });
        report.custom_pars = mapped;
        return report;
      } catch (err) {
        if (!isMissingEndpoint(err)) throw err;
        return runInspectExec(ctx, args, false);
      }
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`inspect_op_extensions_storage failed: ${report.fatal}`, report);
      }
      const storageCount = report.storage ? Object.keys(report.storage).length : 0;
      const extCount = report.extensions?.length ?? 0;
      const parCount = report.custom_pars?.length ?? 0;
      const summary = `${report.path}: ${storageCount} storage key(s), ${extCount} extension(s), ${parCount} custom par(s).`;
      return structuredResult(summary, {
        path: report.path,
        type: report.type,
        storage: report.storage,
        extensions: report.extensions,
        custom_pars: report.custom_pars,
        probe: report.probe,
        warnings: report.warnings,
      });
    },
  );
}

// ---------------------------------------------------------------------------
// Registrar
// ---------------------------------------------------------------------------

export const registerInspectComponent: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "inspect_op_extensions_storage",
    {
      title: "Inspect COMP extensions, storage, and custom parameters",
      description:
        "Read-only: inspect what a COMP exposes — its Python storage dict (keys + values), its extension class descriptors (name, promoted flag, public members), and its custom-parameter definitions (page/name/style/default). Closes the inspect side of the reusable-component loop: use after `scaffold_extension` + `add_custom_parameters` to verify what was built, or call standalone to examine any COMP without resorting to raw Python. Returns structured data for agent code-path consumption. API names vary by TD build; the `probe` field records which attributes were reachable.",
      inputSchema: inspectComponentSchema.shape,
      outputSchema: inspectComponentOutputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    (args) => inspectComponentImpl(ctx, args),
  );
};
