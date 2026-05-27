import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const manageCheckpointSchema = z.object({
  action: z
    .enum(["store", "restore", "list", "delete"])
    .describe(
      "store a full snapshot of a sub-network, restore one, list all, or delete one. A checkpoint is an 'undo point' before risky live edits.",
    ),
  comp_path: z
    .string()
    .default("/project1")
    .describe("Root COMP whose whole sub-network the checkpoint captures."),
  name: z.string().optional().describe("Checkpoint name (required for store/restore/delete)."),
  prune_created: z
    .boolean()
    .default(true)
    .describe("(restore) Destroy nodes that were created after the checkpoint was stored."),
  recreate_deleted: z
    .boolean()
    .default(true)
    .describe(
      "(restore) Recreate nodes that were deleted after the checkpoint (type + params + wiring, best-effort).",
    ),
});
type ManageCheckpointArgs = z.infer<typeof manageCheckpointSchema>;

interface CheckpointReport {
  action: string;
  comp: string;
  name?: string;
  nodes?: number;
  connections?: number;
  checkpoints?: string[];
  deleted?: string;
  restored_params?: number;
  recreated?: string[];
  rewired?: number;
  pruned?: string[];
  warnings: string[];
  fatal?: string;
}

// One Python pass. Checkpoints live in the root COMP's storage under one key, as
// { name: { nodes: [{rel,type,x,y,params}], connections: [{src,so,dst,ti}] } }, so they
// persist with the .toe. Paths are stored relative to the COMP so a restore is robust to
// the COMP itself moving. Only constant-mode, non-read-only parameters are captured —
// expression/exported parameters are derived and restore themselves.
const CHECKPOINT_SCRIPT = `
import json, base64, traceback
import td  # operator classes for recreate live on the td module; exec globals don't expose 'td'
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
KEY = "tdmcp_checkpoints"
report = {"action": _p["action"], "comp": _p["comp"], "warnings": []}
_c = op(_p["comp"])
try:
    if _c is None:
        report["fatal"] = "COMP not found: " + _p["comp"]
    elif not hasattr(_c, "store") or not hasattr(_c, "findChildren"):
        report["fatal"] = _p["comp"] + " cannot hold checkpoints (not a COMP)."
    else:
        _store = dict(_c.fetch(KEY, {}))
        _base = _c.path
        _action = _p["action"]; _name = _p.get("name")
        def _rel(path):
            return path[len(_base):].lstrip("/")
        def _optype(n):
            return getattr(n, "OPType", None) or getattr(n, "type", "") or ""
        if _action == "list":
            report["checkpoints"] = sorted(_store.keys())
        elif _action == "delete":
            if _name in _store:
                _store.pop(_name, None); _c.store(KEY, _store); report["deleted"] = _name
            else:
                report["warnings"].append("Checkpoint not found: " + str(_name))
            report["checkpoints"] = sorted(_store.keys())
        elif _action == "store":
            _children = _c.findChildren()
            _nodes = []
            for _ch in _children:
                _params = {}
                try:
                    for _par in _ch.pars():
                        try:
                            _PM = type(_par.mode)
                            if _par.mode != _PM.CONSTANT or getattr(_par, "readOnly", False):
                                continue
                            _v = _par.eval()
                            try:
                                json.dumps(_v)
                            except Exception:
                                _v = str(_v)
                            _params[_par.name] = _v
                        except Exception:
                            pass
                except Exception:
                    pass
                _nodes.append({
                    "rel": _rel(_ch.path), "type": _optype(_ch),
                    "x": getattr(_ch, "nodeX", 0), "y": getattr(_ch, "nodeY", 0),
                    "params": _params,
                })
            _conns = []
            for _ch in _children:
                for _i, _conn in enumerate(getattr(_ch, "inputConnectors", [])):
                    for _src in getattr(_conn, "connections", []):
                        _owner = getattr(_src, "owner", None)
                        if _owner is None:
                            continue
                        _conns.append({
                            "src": _rel(_owner.path), "so": int(getattr(_src, "index", 0) or 0),
                            "dst": _rel(_ch.path), "ti": _i,
                        })
            _store[_name] = {"nodes": _nodes, "connections": _conns}
            _c.store(KEY, _store)
            report["name"] = _name; report["nodes"] = len(_nodes); report["connections"] = len(_conns)
        elif _action == "restore":
            if _name not in _store:
                report["fatal"] = "Checkpoint not found: '%s' (available: %s)" % (_name, ", ".join(sorted(_store.keys())) or "none")
            else:
                _snap = _store[_name]
                _snap_nodes = _snap.get("nodes", [])
                _snap_rels = set(_n["rel"] for _n in _snap_nodes)
                _cur = {}
                for _ch in _c.findChildren():
                    _cur[_rel(_ch.path)] = _ch
                _recreated = []
                if _p.get("recreate_deleted", True):
                    _missing = [_n for _n in _snap_nodes if _n["rel"] not in _cur]
                    _missing.sort(key=lambda _n: _n["rel"].count("/"))
                    for _n in _missing:
                        _rl = _n["rel"]
                        _pr = _rl.rsplit("/", 1)[0] if "/" in _rl else ""
                        _nm = _rl.rsplit("/", 1)[-1]
                        _parent = _c if _pr == "" else op(_base + "/" + _pr)
                        if _parent is None:
                            report["warnings"].append("Could not recreate %s (parent missing)." % _rl); continue
                        _cls = getattr(td, _n["type"], None)
                        if _cls is None:
                            report["warnings"].append("Could not recreate %s (unknown type %s)." % (_rl, _n["type"])); continue
                        try:
                            _new = _parent.create(_cls, _nm)
                            try:
                                _new.nodeX = _n.get("x", 0); _new.nodeY = _n.get("y", 0)
                            except Exception:
                                pass
                            _cur[_rl] = _new; _recreated.append(_rl)
                        except Exception:
                            report["warnings"].append("Failed to recreate %s: %s" % (_rl, traceback.format_exc().splitlines()[-1]))
                _restored = 0
                for _n in _snap_nodes:
                    _node = _cur.get(_n["rel"])
                    if _node is None:
                        continue
                    for _pn, _pv in (_n.get("params") or {}).items():
                        try:
                            _par = getattr(_node.par, _pn, None)
                            if _par is None:
                                continue
                            _PM = type(_par.mode)
                            if _par.mode != _PM.CONSTANT or getattr(_par, "readOnly", False):
                                continue
                            _par.val = _pv; _restored += 1
                        except Exception:
                            pass
                _rewired = 0
                if _recreated:
                    _rset = set(_recreated)
                    for _cn in _snap.get("connections", []):
                        if _cn["src"] not in _rset and _cn["dst"] not in _rset:
                            continue
                        _s = _cur.get(_cn["src"]); _d = _cur.get(_cn["dst"])
                        if _s is None or _d is None:
                            continue
                        try:
                            _d.inputConnectors[_cn["ti"]].connect(_s.outputConnectors[_cn["so"]]); _rewired += 1
                        except Exception:
                            report["warnings"].append("Could not rewire %s -> %s." % (_cn["src"], _cn["dst"]))
                _pruned = []
                if _p.get("prune_created", True):
                    _extra = [_r for _r in _cur.keys() if _r not in _snap_rels]
                    _extra.sort(key=lambda _r: _r.count("/"), reverse=True)
                    for _r in _extra:
                        _node = op(_base + "/" + _r)
                        if _node is None:
                            continue
                        try:
                            _node.destroy(); _pruned.append(_r)
                        except Exception:
                            report["warnings"].append("Could not prune %s." % _r)
                report["name"] = _name; report["restored_params"] = _restored
                report["recreated"] = _recreated; report["rewired"] = _rewired; report["pruned"] = _pruned
        else:
            report["fatal"] = "Unknown action: " + str(_action)
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildCheckpointScript(payload: object): string {
  return buildPayloadScript(CHECKPOINT_SCRIPT, payload);
}

export async function manageCheckpointImpl(ctx: ToolContext, args: ManageCheckpointArgs) {
  if (args.action !== "list" && !args.name) {
    return errorResult(`A checkpoint name is required for the '${args.action}' action.`);
  }
  return guardTd(
    async () => {
      const script = buildCheckpointScript({
        action: args.action,
        comp: args.comp_path,
        name: args.name,
        prune_created: args.prune_created,
        recreate_deleted: args.recreate_deleted,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<CheckpointReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`Checkpoint ${report.action} failed: ${report.fatal}`, report);
      }
      let summary: string;
      switch (report.action) {
        case "store":
          summary = `Stored checkpoint "${report.name}" on ${report.comp}: ${report.nodes ?? 0} node(s), ${report.connections ?? 0} connection(s).`;
          break;
        case "restore": {
          const parts = [`${report.restored_params ?? 0} parameter(s) restored`];
          if (report.recreated?.length) parts.push(`${report.recreated.length} node(s) recreated`);
          if (report.rewired) parts.push(`${report.rewired} wire(s) reconnected`);
          if (report.pruned?.length) parts.push(`${report.pruned.length} node(s) pruned`);
          summary = `Restored checkpoint "${report.name}" on ${report.comp}: ${parts.join(", ")}.`;
          break;
        }
        case "delete":
          summary = report.deleted
            ? `Deleted checkpoint "${report.deleted}" on ${report.comp}.`
            : `No checkpoint to delete on ${report.comp}.`;
          break;
        default:
          summary = `${report.checkpoints?.length ?? 0} checkpoint(s) on ${report.comp}: ${report.checkpoints?.join(", ") || "none"}.`;
      }
      if (report.warnings.length) summary += ` ${report.warnings.length} warning(s).`;
      return jsonResult(summary, report);
    },
  );
}

export const registerManageCheckpoint: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "manage_checkpoint",
    {
      title: "Manage checkpoint",
      description:
        "Store / restore / list / delete a full snapshot of a sub-network — an 'undo point' to take before risky live edits. A checkpoint captures every node's constant parameters, the wiring, and node positions. Restoring reapplies parameters, recreates nodes that were deleted since (with their wiring), and prunes nodes that were created since. Unlike manage_presets (custom-parameter looks for performance), this captures the whole network for safe experimentation.",
      inputSchema: manageCheckpointSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    (args) => manageCheckpointImpl(ctx, args),
  );
};
