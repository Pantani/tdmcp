import { z } from "zod";
import { friendlyTdError, isMissingEndpoint } from "../../td-client/types.js";
import type { TdNodeDetail } from "../../td-client/validators.js";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const getTdNodeFlagsSchema = z.object({
  path: z
    .string()
    .describe(
      "Full path of the node to inspect, or the COMP whose children to scan when recursive is set.",
    ),
  recursive: z
    .boolean()
    .default(false)
    .describe(
      "Also scan the immediate children (depth 1) of path. Use this on a container to diagnose its whole network in one round-trip.",
    ),
  only_problems: z
    .boolean()
    .default(false)
    .describe(
      "Return only nodes whose flags or cook errors would suppress output: bypass on, allowCooking off, or a cook error present. Conservative — display/render are reported but never used to filter (they default off on many visible ops).",
    ),
  max_nodes: z
    .number()
    .int()
    .min(1)
    .max(500)
    .default(200)
    .describe("Cap the number of nodes scanned during a recursive subtree walk."),
});
type GetTdNodeFlagsArgs = z.infer<typeof getTdNodeFlagsSchema>;

export const nodeFlagsSchema = z.object({
  bypass: z.boolean().optional(),
  render: z.boolean().optional(),
  display: z.boolean().optional(),
  lock: z.boolean().optional(),
  allowCooking: z.boolean().optional(),
  cloneImmune: z.boolean().optional(),
  is_clone: z.boolean().optional(),
  clone: z.string().nullable().optional(),
});

export const nodeWireSchema = z.object({
  in_index: z.number().int().nullable(),
  from: z.string(),
  out_index: z.number().int(),
});

export const nodeFlagsEntrySchema = z.object({
  path: z.string(),
  type: z.string(),
  name: z.string(),
  flags: nodeFlagsSchema,
  wires_in: z.array(nodeWireSchema),
  nodeX: z.number().optional(),
  nodeY: z.number().optional(),
  color: z.array(z.number()).optional(),
  comment: z.string().optional(),
  errors: z.array(z.string()),
  suspect_reason: z.string().optional(),
});

export const getTdNodeFlagsOutputSchema = z.object({
  path: z.string(),
  scanned: z.number().int(),
  nodes: z.array(nodeFlagsEntrySchema),
  probe: z.record(z.string(), z.unknown()).optional(),
  warnings: z.array(z.string()),
});

interface NodeWire {
  in_index: number | null;
  from: string;
  out_index: number;
}

interface NodeFlagsEntry {
  path: string;
  type: string;
  name: string;
  flags: Record<string, unknown>;
  wires_in: NodeWire[];
  nodeX?: number;
  nodeY?: number;
  color?: number[];
  comment?: string;
  errors: string[];
  suspect_reason?: string;
}

interface GetTdNodeFlagsReport {
  path: string;
  scanned: number;
  nodes: NodeFlagsEntry[];
  probe?: Record<string, unknown>;
  warnings: string[];
  fatal?: string;
}

// The payload travels as base64 so arbitrary node paths cannot break Python quoting.
// All TD globals (op, etc.) live inside this script string — never outside it.
//
// Per node it reads the SAME guarded flag/wire/position shape as the bridge
// node_detail producer (keys kept identical on purpose): the family-agnostic bools
// that exist (bypass/render/display/lock/allowCooking/cloneImmune), the COMP-only
// clone signal (is_clone + the par.clone master path — op.clone does NOT exist),
// index-aware input wiring read off inputConnectors (NOT op.inputs, which omits
// empty slots), network position, color, comment, and cook errors.
//
// NOTE on errors: op.errors() returns a STRING (e.g. "" or "Warning: ..."), not a
// list — so it becomes `[s] if s else []`, never iterated char-by-char.
const GET_FLAGS_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"path": _p["path"], "scanned": 0, "nodes": [], "warnings": []}

def _flags(_o):
    out = {}
    for _attr in ("bypass", "render", "display", "lock", "allowCooking", "cloneImmune"):
        try:
            _v = getattr(_o, _attr)
            if isinstance(_v, bool):
                out[_attr] = _v
        except Exception:
            pass
    # clone is COMP-only and lives on .par.clone (path to master), NOT op.clone.
    try:
        if hasattr(_o, "isClone"):
            out["is_clone"] = bool(_o.isClone)
    except Exception:
        pass
    try:
        _cp = getattr(_o.par, "clone", None)
        if _cp is not None:
            _cv = _cp.eval()
            out["clone"] = str(_cv) if _cv else None
    except Exception:
        pass
    return out

def _wires_in(_o):
    # Faithful, index-aware: iterate inputConnectors (NOT _o.inputs, which omits
    # empty slots). Each wire => {in_index, from, out_index}.
    _wires = []
    try:
        for _ic in _o.inputConnectors:
            try:
                _in_index = _ic.index
            except Exception:
                _in_index = None
            try:
                _conns = list(_ic.connections)
            except Exception:
                _conns = []
            for _oc in _conns:
                try:
                    _wires.append({"in_index": _in_index, "from": _oc.owner.path, "out_index": _oc.index})
                except Exception:
                    pass
    except Exception:
        pass
    return _wires

def _errors(_o):
    # op.errors() returns a STRING, not a list — wrap it, never iterate it.
    try:
        _s = _o.errors(recurse=False)
        if _s:
            return [str(_s)]
    except Exception:
        pass
    return []

def _entry(_o, _only_problems):
    _e = {
        "path": _o.path,
        "type": _o.type,
        "name": _o.name,
        "flags": _flags(_o),
        "wires_in": _wires_in(_o),
        "errors": _errors(_o),
    }
    try:
        _e["nodeX"] = _o.nodeX
        _e["nodeY"] = _o.nodeY
    except Exception:
        pass
    try:
        _e["color"] = list(_o.color)
    except Exception:
        pass
    try:
        if _o.comment:
            _e["comment"] = _o.comment
    except Exception:
        pass
    # Conservative suspect classification: only the unambiguous, high-signal cases.
    _reasons = []
    if _e["flags"].get("bypass") is True:
        _reasons.append("bypass on")
    if _e["flags"].get("allowCooking") is False:
        _reasons.append("cooking disabled")
    if _e["errors"]:
        _reasons.append("cook error")
    if _reasons:
        _e["suspect_reason"] = ", ".join(_reasons)
    return _e, bool(_reasons)

try:
    _root = op(_p["path"])
    if _root is None:
        report["fatal"] = "Node not found: " + str(_p["path"])
    else:
        _only = bool(_p.get("only_problems", False))
        _recursive = bool(_p.get("recursive", False))
        _max = int(_p.get("max_nodes", 200))
        _targets = [_root]
        if _recursive:
            try:
                _targets += list(_root.findChildren(depth=1))
            except Exception as _fe:
                report["warnings"].append("findChildren failed: " + str(_fe))
        _first = True
        for _o in _targets:
            if report["scanned"] >= _max:
                report["warnings"].append("max_nodes (" + str(_max) + ") reached; subtree scan truncated.")
                break
            report["scanned"] += 1
            try:
                # Probe the first node's available flags to confirm the real TD API.
                if _first:
                    _first = False
                    try:
                        report["probe"] = {
                            "flags_present": sorted(_flags(_o).keys()),
                            "has_inputConnectors": hasattr(_o, "inputConnectors"),
                            "errors_is_str": isinstance(_o.errors(recurse=False), str),
                        }
                    except Exception:
                        report["probe"] = {"error": traceback.format_exc().splitlines()[-1]}
                _ent, _is_problem = _entry(_o, _only)
                if _only and not _is_problem:
                    continue
                report["nodes"].append(_ent)
            except Exception:
                try:
                    report["warnings"].append("Error reading " + str(_o.path) + ": " + traceback.format_exc().splitlines()[-1])
                except Exception:
                    report["warnings"].append("Error reading node: " + traceback.format_exc().splitlines()[-1])
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildGetFlagsScript(payload: object): string {
  return buildPayloadScript(GET_FLAGS_SCRIPT, payload);
}

// Map a structured node_detail (REST) into the flags-entry shape. NodeDetail's
// flags/wires_in are the SAME shapes this tool emits (kept identical on purpose),
// so this is a faithful copy plus the same suspect classification the exec walk
// applies (bypass on / cooking disabled / cook error present).
function detailToFlagsEntry(d: TdNodeDetail): NodeFlagsEntry {
  const errors = d.errors ?? [];
  const flags = (d.flags ?? {}) as Record<string, unknown>;
  const entry: NodeFlagsEntry = {
    path: d.path,
    type: d.type,
    name: d.name,
    flags,
    wires_in: d.wires_in ?? [],
    errors,
  };
  if (d.nodeX !== undefined) entry.nodeX = d.nodeX;
  if (d.nodeY !== undefined) entry.nodeY = d.nodeY;
  if (d.color !== undefined) entry.color = d.color;
  if (d.comment) entry.comment = d.comment;
  const reasons: string[] = [];
  if (flags.bypass === true) reasons.push("bypass on");
  if (flags.allowCooking === false) reasons.push("cooking disabled");
  if (errors.length > 0) reasons.push("cook error");
  if (reasons.length > 0) entry.suspect_reason = reasons.join(", ");
  return entry;
}

export async function getTdNodeFlagsImpl(ctx: ToolContext, args: GetTdNodeFlagsArgs) {
  return guardTd(
    async () => {
      // REST-first: the structured node_detail endpoint carries the SAME
      // flags/wires_in/errors/position/color/comment and survives
      // TDMCP_BRIDGE_ALLOW_EXEC=0. Fall back to the exec walk only on an older
      // bridge — no /api/nodes route (isMissingEndpoint) or a node_detail that
      // predates the flags extension (root.flags is undefined).
      try {
        const root = await ctx.client.getNode(args.path);
        if (root.flags !== undefined) {
          const report: GetTdNodeFlagsReport = {
            path: args.path,
            scanned: 0,
            nodes: [],
            warnings: [],
          };
          const details: TdNodeDetail[] = [root];
          if (args.recursive) {
            // One list call for the immediate children (depth 1), then a detail
            // read each — N+1 requests, but exec-gate-free. Capped at max_nodes.
            try {
              const list = await ctx.client.getNodes(args.path);
              for (const child of list.nodes) {
                if (details.length >= args.max_nodes) {
                  report.warnings.push(
                    `max_nodes (${args.max_nodes}) reached; subtree scan truncated.`,
                  );
                  break;
                }
                try {
                  details.push(await ctx.client.getNode(child.path));
                } catch (childErr) {
                  report.warnings.push(`Error reading ${child.path}: ${friendlyTdError(childErr)}`);
                }
              }
            } catch (listErr) {
              report.warnings.push(`findChildren failed: ${friendlyTdError(listErr)}`);
            }
          }
          for (const d of details) {
            report.scanned += 1;
            const entry = detailToFlagsEntry(d);
            if (args.only_problems && !entry.suspect_reason) continue;
            report.nodes.push(entry);
          }
          report.probe = { endpoint: "node_detail", flags_present: Object.keys(root.flags).sort() };
          return report;
        }
        // node_detail without flags -> older bridge -> exec fallback below.
      } catch (err) {
        // connection/timeout/validation propagate; only a missing route falls back.
        if (!isMissingEndpoint(err)) throw err;
      }

      // Fallback: the exec walk (older bridge, or with ALLOW_EXEC on). Same shape.
      const script = buildGetFlagsScript({
        path: args.path,
        recursive: args.recursive,
        only_problems: args.only_problems,
        max_nodes: args.max_nodes,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<GetTdNodeFlagsReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`get_td_node_flags failed: ${report.fatal}`, report);
      }
      const suspects = report.nodes.filter((n) => n.suspect_reason).length;
      const scope = args.recursive ? " (subtree)" : "";
      const summary = `Inspected ${report.scanned} node(s) under ${report.path}${scope} — ${report.nodes.length} reported, ${suspects} suspect.`;
      return structuredResult(summary, {
        path: report.path,
        scanned: report.scanned,
        nodes: report.nodes,
        probe: report.probe,
        warnings: report.warnings,
      });
    },
  );
}

export const registerGetTdNodeFlags: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "get_td_node_flags",
    {
      title: "Get node flags & wiring (why-is-it-black inspector)",
      description:
        "Read-only: report each node's operator flags (bypass / render / display / lock / allowCooking / clone) plus index-aware input wiring, network position, color and comment — the signals that explain a black/blank output that a parameter dump hides. Scan one node or a subtree (recursive); set only_problems to surface just the ops whose flags or cook errors would suppress output. Returns structuredContent for code to process.",
      inputSchema: getTdNodeFlagsSchema.shape,
      outputSchema: getTdNodeFlagsOutputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    (args) => getTdNodeFlagsImpl(ctx, args),
  );
};
