import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const createReplicatorSchema = z.object({
  parent_path: z.string().default("/project1").describe("COMP to build the replicator inside."),
  name: z.string().default("replicator1").describe("Name for the Replicator COMP."),
  template_path: z
    .string()
    .optional()
    .describe(
      "Existing COMP to clone per row. Omit → create a minimal template COMP (a container with a Text).",
    ),
  table_path: z
    .string()
    .optional()
    .describe("Table DAT whose rows drive the clones. Omit → create a small example Table DAT."),
  rows: z
    .number()
    .int()
    .min(0)
    .max(64)
    .default(0)
    .describe("When creating an example table, how many example rows (0 = a 3-row demo)."),
  callback_stub: z
    .boolean()
    .default(true)
    .describe("Generate an onReplicate callback DAT stub (per-clone setup hook)."),
});
type CreateReplicatorArgs = z.infer<typeof createReplicatorSchema>;

interface ReplicatorReport {
  replicator?: string;
  template?: string;
  table?: string;
  callbacks?: string;
  clones_estimated?: number;
  probe: { par_attrs?: string[]; set?: Record<string, string>; missing?: string[] };
  warnings: string[];
  fatal?: string;
}

// A Replicator COMP clones a template per row of a Table DAT — TD's idiomatic
// "N copies from data" mechanism. There is no dedicated bridge endpoint, so the
// whole build runs in one Python pass. The Replicator parameter names vary by
// TD build, so every par is set PROBE-FIRST: we walk a list of candidate names
// with getattr and record which one took, rather than guessing one and failing
// silently. `report["probe"]["par_attrs"]` carries the live par list so the real
// names can be confirmed. The script touches `op`/COMP creation, which exist only
// inside the bridge's exec scope.
const REPLICATOR_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"probe": {"set": {}, "missing": []}, "warnings": []}
try:
    _parent = op(_p["parent_path"])
    if _parent is None:
        report["fatal"] = "Parent COMP not found: " + str(_p["parent_path"])
    else:
        def _try_set(_obj, _names, _value, _key):
            # Set the first parameter on _obj whose name matches a candidate.
            for _n in _names:
                _par = getattr(_obj.par, _n, None)
                if _par is not None:
                    try:
                        _par.val = _value
                        report["probe"]["set"][_key] = _n
                        return _n
                    except Exception as _e:
                        report["warnings"].append("Could not set " + _n + ": " + str(_e))
            report["probe"]["missing"].append(_key)
            return None

        # --- template COMP (what gets cloned) ---
        _tmpl = op(_p["template_path"]) if _p.get("template_path") else None
        if _p.get("template_path") and _tmpl is None:
            report["warnings"].append("template_path not found, creating a minimal one: " + str(_p["template_path"]))
        if _tmpl is None:
            _tmpl = _parent.create(containerCOMP, _p["name"] + "_template")
            try:
                _txt = _tmpl.create(textTOP, "label")
                _txt.par.text = "item"
            except Exception as _e:
                report["warnings"].append("Template Text TOP skipped: " + str(_e))
        report["template"] = _tmpl.path

        # --- table DAT (rows drive the clones) ---
        _tbl = op(_p["table_path"]) if _p.get("table_path") else None
        if _p.get("table_path") and _tbl is None:
            report["warnings"].append("table_path not found, creating an example one: " + str(_p["table_path"]))
        if _tbl is None:
            _tbl = _parent.create(tableDAT, _p["name"] + "_table")
            try:
                _tbl.clear()
                _tbl.appendRow(["name", "label"])
                _n = _p.get("rows") or 3
                for _i in range(int(_n)):
                    _tbl.appendRow(["item" + str(_i + 1), "Item " + str(_i + 1)])
            except Exception as _e:
                report["warnings"].append("Example table fill skipped: " + str(_e))
        report["table"] = _tbl.path
        try:
            report["clones_estimated"] = max(0, _tbl.numRows - 1)
        except Exception:
            report["clones_estimated"] = None

        # --- replicator ---
        _rep = _parent.create(replicatorCOMP, _p["name"])
        report["replicator"] = _rep.path
        # The replicator reads its driving rows from the "template" DAT par and
        # clones the "master" operator; replication method is a menu (value
        # "bytable"). Each is set probe-first across known name variants.
        _try_set(_rep, ["template", "table", "dat"], _tbl.path, "table_par")
        _try_set(_rep, ["master", "clone", "templateop"], _tmpl.path, "master_par")
        _try_set(_rep, ["replicator", "replicationmethod", "method"], "bytable", "method_par")

        # --- callbacks DAT stub ---
        if _p.get("callback_stub"):
            _cb = _parent.create(textDAT, _p["name"] + "_callbacks")
            _cb.text = (
                "# Replicator callbacks — runs once per clone.\\n"
                "# See replicatorCOMP_Class for the full signature.\\n\\n"
                "def onReplicate(comp, allOps, newOps, template, master):\\n"
                "    for c in newOps:\\n"
                "        # per-clone setup, e.g. read its row: c.par or template values\\n"
                "        pass\\n"
                "    return\\n"
            )
            report["callbacks"] = _cb.path
            _try_set(_rep, ["callbacks", "callbacksdat", "callbackdat"], _cb.path, "callbacks_par")

        # --- trigger a (re)replicate so clones appear now ---
        _pulsed = False
        for _pn in ["recreateall", "enablecloningpulse", "pulse"]:
            _par = getattr(_rep.par, _pn, None)
            if _par is not None:
                try:
                    _par.pulse()
                    report["probe"]["set"]["pulse_par"] = _pn
                    _pulsed = True
                    break
                except Exception as _e:
                    report["warnings"].append("Could not pulse " + _pn + ": " + str(_e))
        if not _pulsed:
            report["probe"]["missing"].append("pulse_par")

        if report["probe"]["missing"]:
            report["warnings"].append(
                "No matching parameter for: " + ", ".join(report["probe"]["missing"]) + " — see probe.par_attrs."
            )

        try:
            report["probe"]["par_attrs"] = sorted([a for a in dir(_rep.par) if not a.startswith("_")])[:80]
        except Exception:
            report["probe"]["par_attrs"] = []
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildReplicatorScript(payload: object): string {
  return buildPayloadScript(REPLICATOR_SCRIPT, payload);
}

export async function createReplicatorImpl(ctx: ToolContext, args: CreateReplicatorArgs) {
  return guardTd(
    async () => {
      const script = buildReplicatorScript({
        parent_path: args.parent_path,
        name: args.name,
        template_path: args.template_path ?? null,
        table_path: args.table_path ?? null,
        rows: args.rows,
        callback_stub: args.callback_stub,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<ReplicatorReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`Replicator build failed: ${report.fatal}`, report);
      }
      const probe = report.probe?.set
        ? Object.entries(report.probe.set)
            .map(([k, v]) => `${k}=${v}`)
            .join(", ")
        : "none";
      const clones =
        typeof report.clones_estimated === "number" ? `, ~${report.clones_estimated} clone(s)` : "";
      const warn = report.warnings.length ? ` (${report.warnings.length} warning(s))` : "";
      const summary = `Built replicator ${report.replicator} cloning ${report.template} per row of ${report.table}${clones} (probe: ${probe})${warn}.`;
      return jsonResult(summary, report);
    },
  );
}

export const registerCreateReplicator: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_replicator",
    {
      title: "Create Replicator (clone a template per data row)",
      description:
        "Wire a Replicator COMP that clones a template COMP once per row of a Table DAT — TouchDesigner's idiomatic 'N copies from data' mechanism (menus, scoreboards, per-track decks, instanced panels). Resolves or creates the template COMP (omit template_path → a minimal container with a Text) and the driving Table DAT (omit table_path → a small example table; `rows` sets how many demo rows), creates the replicator under parent_path, points its driving-table and master parameters at them, sets the replication method to 'by table', and optionally drops an onReplicate callback DAT stub for per-clone setup. The Replicator's parameter names vary by TD build, so each is set probe-first and the report includes which parameter took plus the live parameter list. Then it pulses a re-replicate so the clones appear. Re-replicating is destructive to previously generated clones, which the replicator deletes and re-creates on cook.",
      inputSchema: createReplicatorSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createReplicatorImpl(ctx, args),
  );
};
