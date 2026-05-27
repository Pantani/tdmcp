import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const managePresetsSchema = z.object({
  action: z
    .enum(["store", "recall", "list", "delete"])
    .describe("store a snapshot, recall one, list all, or delete one."),
  comp_path: z
    .string()
    .default("/project1")
    .describe(
      "COMP whose parameter values the preset captures — usually a control-panel container.",
    ),
  name: z.string().optional().describe("Preset name (required for store/recall/delete)."),
  params: z
    .array(z.string())
    .optional()
    .describe(
      "Specific custom-parameter names to capture/restore. Defaults to every custom parameter on the COMP.",
    ),
});
type ManagePresetsArgs = z.infer<typeof managePresetsSchema>;

interface PresetReport {
  action: string;
  comp: string;
  name?: string;
  captured?: string[];
  restored?: string[];
  deleted?: string;
  presets?: string[];
  warnings: string[];
  fatal?: string;
}

// Presets live in the COMP's storage under one key, as { presetName: { parName: value } }.
// Storage persists with the .toe, so snapshots survive a save/reload. Recalling writes
// values back onto the (constant-mode) custom parameters, which propagates through any
// bindings created by create_control_panel.
const PRESETS_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
KEY = "tdmcp_presets"
report = {"action": _p["action"], "comp": _p["comp"], "warnings": []}
_c = op(_p["comp"])
try:
    if _c is None:
        report["fatal"] = "COMP not found: " + _p["comp"]
    elif not hasattr(_c, "customPars"):
        report["fatal"] = _p["comp"] + " is not a COMP, so it has no custom parameters to snapshot."
    else:
        _store = dict(_c.fetch(KEY, {}))
        _action = _p["action"]; _name = _p.get("name")
        if _action == "list":
            report["presets"] = sorted(_store.keys())
        elif _action == "store":
            _wanted = _p.get("params") or None
            _pars = list(_c.customPars) if _wanted is None else [getattr(_c.par, n, None) for n in _wanted]
            _vals = {}
            for _pr in _pars:
                if _pr is None:
                    continue
                _vals[_pr.name] = _pr.eval()
            _store[_name] = _vals; _c.store(KEY, _store)
            report["name"] = _name; report["captured"] = sorted(_vals.keys()); report["presets"] = sorted(_store.keys())
        elif _action == "recall":
            if _name not in _store:
                report["fatal"] = "Preset not found: '%s' (available: %s)" % (_name, ", ".join(sorted(_store.keys())) or "none")
            else:
                _restored = []
                for _nm, _v in _store[_name].items():
                    _pr = getattr(_c.par, _nm, None)
                    if _pr is None:
                        report["warnings"].append("Parameter no longer exists: " + _nm); continue
                    if _pr.readOnly:
                        report["warnings"].append("Parameter is read-only: " + _nm); continue
                    try:
                        _pr.val = _v; _restored.append(_nm)
                    except Exception:
                        report["warnings"].append("Could not restore " + _nm)
                report["name"] = _name; report["restored"] = sorted(_restored)
        elif _action == "delete":
            if _name in _store:
                _store.pop(_name, None); _c.store(KEY, _store); report["deleted"] = _name
            else:
                report["warnings"].append("Preset not found: " + str(_name))
            report["presets"] = sorted(_store.keys())
        else:
            report["fatal"] = "Unknown action: " + str(_action)
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildPresetsScript(payload: object): string {
  return buildPayloadScript(PRESETS_SCRIPT, payload);
}

export async function managePresetsImpl(ctx: ToolContext, args: ManagePresetsArgs) {
  if (args.action !== "list" && !args.name) {
    return errorResult(`A preset name is required for the '${args.action}' action.`);
  }
  return guardTd(
    async () => {
      const script = buildPresetsScript({
        action: args.action,
        comp: args.comp_path,
        name: args.name,
        params: args.params ?? null,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<PresetReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`Preset ${report.action} failed: ${report.fatal}`, report);
      }
      let summary: string;
      switch (report.action) {
        case "store":
          summary = `Stored preset "${report.name}" (${report.captured?.length ?? 0} parameter(s)) on ${report.comp}.`;
          break;
        case "recall":
          summary = `Recalled preset "${report.name}" (${report.restored?.length ?? 0} parameter(s) restored) on ${report.comp}.`;
          break;
        case "delete":
          summary = report.deleted
            ? `Deleted preset "${report.deleted}" on ${report.comp}.`
            : `No preset to delete on ${report.comp}.`;
          break;
        default:
          summary = `${report.presets?.length ?? 0} preset(s) on ${report.comp}: ${report.presets?.join(", ") || "none"}.`;
      }
      if (report.warnings.length) summary += ` ${report.warnings.length} warning(s).`;
      return jsonResult(summary, report);
    },
  );
}

export const registerManagePresets: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "manage_presets",
    {
      title: "Manage presets",
      description:
        "Store, recall, list, or delete named snapshots of a COMP's parameter values — the live-performance preset system. Pair with create_control_panel: snapshot the knob positions and jump between looks. Snapshots are saved in the COMP's storage so they persist with the project.",
      inputSchema: managePresetsSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => managePresetsImpl(ctx, args),
  );
};
