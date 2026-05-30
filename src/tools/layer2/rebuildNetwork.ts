import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

// One parameter entry in a serialized spec. `mode` mirrors serialize_network /
// read_parameter_modes output (CONSTANT / EXPRESSION / BIND / EXPORT, case-
// insensitive); `value` is used for constants, `expr` for expression/bind modes.
const ParamSpec = z.object({
  value: z
    .unknown()
    .optional()
    .describe("Constant value for the parameter (used when mode is constant or omitted)."),
  mode: z
    .string()
    .optional()
    .describe(
      "Parameter mode: 'EXPRESSION', 'BIND', or 'CONSTANT' (case-insensitive). Omit for a plain constant.",
    ),
  expr: z
    .string()
    .optional()
    .describe(
      "Expression or bind string, required when mode is EXPRESSION or BIND, e.g. 'me.time.seconds'.",
    ),
});

const NodeSpec = z.object({
  name: z
    .string()
    .describe("Name for the node inside the parent (TD may adjust it to avoid collisions)."),
  type: z.string().describe("Operator type to create, e.g. 'noiseTOP', 'levelTOP'."),
  params: z
    .record(z.string(), ParamSpec)
    .default({})
    .describe("Map of parameter name → { value | mode | expr } to apply after creation."),
  inputs: z
    .array(
      z.object({
        from: z.string().describe("Name of an earlier node in this spec to wire from."),
        out_index: z
          .number()
          .int()
          .default(0)
          .describe("Output connector index on the source node (default 0)."),
        in_index: z
          .number()
          .int()
          .default(0)
          .describe("Input connector index on this node (default 0)."),
      }),
    )
    .default([])
    .describe("Inbound wires for this node, each referencing another node by `from` name."),
  x: z.number().optional().describe("Optional node X position (nodeX) in the network editor."),
  y: z.number().optional().describe("Optional node Y position (nodeY) in the network editor."),
});

export const rebuildNetworkSchema = z.object({
  parent_path: z.string().describe("COMP to rebuild the network inside."),
  spec: z
    .object({
      root: z
        .string()
        .optional()
        .describe("Original root path the spec was serialized from (informational only)."),
      nodes: z.array(NodeSpec).describe("Nodes to create, parameterize, and wire, in order."),
    })
    .describe("A serialize_network spec to reconstruct."),
  clear_existing: z
    .boolean()
    .default(false)
    .describe("Delete existing children of parent_path first (destructive)."),
});
type RebuildNetworkArgs = z.infer<typeof rebuildNetworkSchema>;

interface RebuildNetworkReport {
  parent_path: string;
  created: string[];
  wired: number;
  params_set: number;
  cleared: number;
  warnings: string[];
  fatal?: string;
}

// All TD globals (op, the operator-type names, ParMode) live inside this script
// string — never reference them from TS. The payload travels as base64 so quotes,
// newlines, and unicode in artist strings / expressions cannot break Python
// quoting. The whole rebuild is one pass: create → param/expr → wire, with a
// name→path map so later wires resolve to the freshly created paths.
const REBUILD_SCRIPT = `
import json, base64, traceback
import td  # operator classes are resolved by name off the td module; exec globals don't expose 'td'
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"parent_path": _p["parent_path"], "created": [], "wired": 0, "params_set": 0, "cleared": 0, "warnings": []}
try:
    _parent = op(_p["parent_path"])
    if _parent is None:
        report["fatal"] = "Parent COMP not found: " + str(_p["parent_path"])
    else:
        _nodes = _p["spec"].get("nodes", [])
        # Optional destructive pre-clear of existing children.
        if _p.get("clear_existing"):
            for _child in list(_parent.children):
                try:
                    _child.destroy()
                    report["cleared"] += 1
                except Exception:
                    report["warnings"].append("Could not delete child " + str(getattr(_child, "name", "?")) + ": " + traceback.format_exc().splitlines()[-1])
        # PASS 1 — create nodes; build a name -> created op map.
        _byname = {}
        for _n in _nodes:
            _name = _n.get("name")
            _type = _n.get("type")
            # Resolve the operator type by NAME off the td module — never hand the
            # caller-supplied string to a Python evaluator (that would be arbitrary
            # code execution in the TD process). getattr can't run code, and
            # isidentifier() rejects any non-name input. Unknown type -> fail-forward
            # warning, like every other pass.
            _optype = getattr(td, _type, None) if isinstance(_type, str) and _type.isidentifier() else None
            if _optype is None:
                report["warnings"].append("Unknown operator type '" + str(_type) + "' for node '" + str(_name) + "'")
                continue
            try:
                _new = _parent.create(_optype, _name)
                _byname[_name] = _new
                report["created"].append(_new.name)
                if _n.get("x") is not None:
                    try:
                        _new.nodeX = _n.get("x")
                    except Exception:
                        pass
                if _n.get("y") is not None:
                    try:
                        _new.nodeY = _n.get("y")
                    except Exception:
                        pass
            except Exception:
                report["warnings"].append("Create failed for node '" + str(_name) + "' (" + str(_type) + "): " + traceback.format_exc().splitlines()[-1])
        # PASS 2 — set params (constants + expressions + binds), fail-forward per par.
        for _n in _nodes:
            _name = _n.get("name")
            _node = _byname.get(_name)
            if _node is None:
                continue
            for _pname, _spec in (_n.get("params") or {}).items():
                try:
                    _par = getattr(_node.par, _pname, None)
                    if _par is None:
                        report["warnings"].append("No such parameter '" + str(_pname) + "' on node '" + str(_name) + "'")
                        continue
                    _mode = (_spec.get("mode") or "").upper()
                    if _mode == "EXPRESSION":
                        _e = _spec.get("expr")
                        if not _e:
                            report["warnings"].append("param '" + str(_pname) + "' on '" + str(_name) + "': expr required for EXPRESSION mode")
                            continue
                        _par.expr = _e
                        try:
                            _par.mode = type(_par.mode).EXPRESSION
                        except Exception:
                            report["warnings"].append("Could not set EXPRESSION mode for '" + str(_pname) + "' on '" + str(_name) + "'")
                        report["params_set"] += 1
                    elif _mode == "BIND":
                        _e = _spec.get("expr")
                        if not _e:
                            report["warnings"].append("param '" + str(_pname) + "' on '" + str(_name) + "': expr required for BIND mode")
                            continue
                        _par.bindExpr = _e
                        try:
                            _par.mode = type(_par.mode).BIND
                        except Exception:
                            report["warnings"].append("Could not set BIND mode for '" + str(_pname) + "' on '" + str(_name) + "'")
                        report["params_set"] += 1
                    else:
                        _v = _spec.get("value")
                        if _v is None:
                            report["warnings"].append("param '" + str(_pname) + "' on '" + str(_name) + "': no value to set")
                            continue
                        _par.val = _v
                        try:
                            _par.mode = type(_par.mode).CONSTANT
                        except Exception:
                            pass
                        report["params_set"] += 1
                except Exception:
                    report["warnings"].append("param '" + str(_pname) + "' on '" + str(_name) + "': " + traceback.format_exc().splitlines()[-1])
        # PASS 3 — wire inputs, resolving 'from' via the name -> op map.
        for _n in _nodes:
            _name = _n.get("name")
            _dst = _byname.get(_name)
            if _dst is None:
                continue
            for _wire in (_n.get("inputs") or []):
                _from = _wire.get("from")
                _src = _byname.get(_from)
                if _src is None:
                    report["warnings"].append("wire into '" + str(_name) + "': source node '" + str(_from) + "' not found in spec")
                    continue
                try:
                    _ii = int(_wire.get("in_index", 0))
                    _oi = int(_wire.get("out_index", 0))
                    _dst.inputConnectors[_ii].connect(_src.outputConnectors[_oi])
                    report["wired"] += 1
                except Exception:
                    report["warnings"].append("wire '" + str(_from) + "' -> '" + str(_name) + "': " + traceback.format_exc().splitlines()[-1])
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildRebuildScript(payload: object): string {
  return buildPayloadScript(REBUILD_SCRIPT, payload);
}

export async function rebuildNetworkImpl(ctx: ToolContext, args: RebuildNetworkArgs) {
  return guardTd(
    async () => {
      const script = buildRebuildScript({
        parent_path: args.parent_path,
        spec: args.spec,
        clear_existing: args.clear_existing,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<RebuildNetworkReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(
          `rebuild_network failed on ${args.parent_path}: ${report.fatal}`,
          report,
        );
      }
      const nWarn = report.warnings.length;
      const summary =
        `Rebuilt ${report.created.length} node(s), ${report.wired} wire(s) under ${report.parent_path}` +
        `${report.cleared > 0 ? `, cleared ${report.cleared} existing` : ""}` +
        `${nWarn > 0 ? ` (${nWarn} warning(s))` : ""}.`;
      return jsonResult(summary, report);
    },
  );
}

export const registerRebuildNetwork: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "rebuild_network",
    {
      title: "Rebuild network from a spec",
      description:
        "Reconstruct a live network inside a COMP from a serialize_network spec — the REBUILD half of a git-diffable round-trip. Takes a JSON spec of nodes (name, operator type, parameters as constants/expressions/binds, inbound wires by name, optional x/y) and, in one pass, creates every node, applies its parameters and expressions, then wires inputs by resolving each `from` reference to the freshly created node. Fail-forward: an unknown operator type, missing parameter, or unresolved wire becomes a warning and the rest still build, so a partial reconstruction still returns useful results. Set clear_existing to delete the parent's current children first (destructive). Returns the created node names, wire count, parameters set, and any warnings.",
      inputSchema: rebuildNetworkSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    (args) => rebuildNetworkImpl(ctx, args),
  );
};
