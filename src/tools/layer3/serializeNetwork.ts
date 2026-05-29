import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const serializeNetworkSchema = z.object({
  path: z.string().describe("Root COMP whose children to serialize into a diffable spec."),
  max_nodes: z.number().int().min(1).max(500).default(200).describe("Cap nodes serialized."),
  include_custom_params: z
    .boolean()
    .default(true)
    .describe("Include custom-parameter definitions (best-effort)."),
});
type SerializeNetworkArgs = z.infer<typeof serializeNetworkSchema>;

// SHARED SPEC SHAPE — this output is the exact INPUT that the sibling `rebuild_network`
// tool consumes. The two MUST stay identical so a subtree round-trips: serialize →
// JSON spec → rebuild reconstructs the same nodes/types/params/wires.
const SerializedParamSchema = z.object({
  value: z.unknown().optional().describe("Evaluated parameter value."),
  mode: z
    .string()
    .optional()
    .describe("Parameter mode (CONSTANT / EXPRESSION / EXPORT / BIND), normalized."),
  expr: z.string().optional().describe("Raw expression string when the mode is EXPRESSION."),
});

const SerializedInputSchema = z.object({
  from: z.string().describe("Source node NAME (within root) feeding this input."),
  out_index: z.number().describe("Output connector index on the source node."),
  in_index: z.number().describe("Input connector index on this node."),
});

const SerializedCustomParSchema = z.object({
  name: z.string().describe("Custom parameter name."),
  page: z.string().optional().describe("Parameter page the knob lives on."),
  style: z.string().optional().describe("Parameter style (Float, Int, Toggle, Menu, …)."),
  default: z.unknown().optional().describe("Default value, best-effort (UNVERIFIED shape)."),
});

const SerializedNodeSchema = z.object({
  name: z.string().describe("Node name (unique within root)."),
  type: z.string().describe('TD op type, e.g. "noiseTOP".'),
  params: z
    .record(z.string(), SerializedParamSchema)
    .describe("Non-default / interesting params keyed by parameter name."),
  inputs: z.array(SerializedInputSchema).describe("Input wires, by source node NAME."),
  x: z.number().optional().describe("Node X position (cosmetic)."),
  y: z.number().optional().describe("Node Y position (cosmetic)."),
  custom_params: z
    .array(SerializedCustomParSchema)
    .optional()
    .describe(
      "Custom-parameter definitions so rebuild can recreate knobs (best-effort, UNVERIFIED).",
    ),
});

export const serializeNetworkOutputSchema = z.object({
  root: z.string().describe("The serialized root path."),
  nodes: z.array(SerializedNodeSchema).describe("Every serialized child node of the root."),
  truncated: z
    .boolean()
    .optional()
    .describe("True when the child count exceeded max_nodes and the spec was capped."),
  warnings: z.array(z.string()).describe("Per-item problems collected without failing the read."),
});

interface SerializedParam {
  value?: unknown;
  mode?: string;
  expr?: string;
}

interface SerializedInput {
  from: string;
  out_index: number;
  in_index: number;
}

interface SerializedCustomPar {
  name: string;
  page?: string;
  style?: string;
  default?: unknown;
}

interface SerializedNode {
  name: string;
  type: string;
  params: Record<string, SerializedParam>;
  inputs: SerializedInput[];
  x?: number;
  y?: number;
  custom_params?: SerializedCustomPar[];
}

interface SerializeNetworkReport {
  root: string;
  nodes: SerializedNode[];
  truncated?: boolean;
  warnings: string[];
  fatal?: string;
}

// One Python pass: walk the root's depth-1 children (the safe diffable unit — a node's
// own immediate contents, not the whole nested tree), capture each node's type, position,
// parameters (value + normalized mode + raw expression), input wires by SOURCE NAME, and
// optionally its custom-parameter definitions. The defensive per-attribute try/except read
// mirrors readParameterModes.ts so one unreadable par never sinks the serialization.
// The payload travels as base64 so artist strings cannot break Python quoting, and every
// TD global (op, etc.) lives only inside this string.
const SERIALIZE_NETWORK_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"root": _p["path"], "nodes": [], "warnings": []}
try:
    _root = op(_p["path"])
    if _root is None:
        report["fatal"] = "Root not found: " + str(_p["path"])
    else:
        _max = int(_p.get("max_nodes", 200))
        _include_custom = bool(_p.get("include_custom_params", True))
        # depth=1 is the safe diffable unit: the root's immediate children only, so wires
        # resolve by name within the root and rebuild can reconstruct them.
        try:
            _children = _root.findChildren(depth=1)
        except Exception:
            try:
                _children = list(_root.children)
            except Exception:
                _children = []
                report["warnings"].append("Could not enumerate children of " + str(_p["path"]))
        if len(_children) > _max:
            report["truncated"] = True
            _children = _children[:_max]
        # Names present in the serialized set — wires to anything outside are flagged.
        _names = set()
        for _o in _children:
            try:
                _names.add(_o.name)
            except Exception:
                pass
        for _o in _children:
            _node = {"name": "", "type": "", "params": {}, "inputs": []}
            try:
                _node["name"] = _o.name
            except Exception:
                report["warnings"].append("Skipped a child with no readable name.")
                continue
            try:
                _node["type"] = _o.type
            except Exception:
                report["warnings"].append("Could not read type for " + _node["name"])
            # Position (cosmetic) — guard, some ops may not expose nodeX/nodeY.
            try:
                _node["x"] = _o.nodeX
            except Exception:
                pass
            try:
                _node["y"] = _o.nodeY
            except Exception:
                pass
            # Parameters: value + normalized mode + raw expression, defensively per attribute.
            try:
                _pars = _o.pars()
            except Exception:
                _pars = []
                report["warnings"].append("Could not enumerate parameters for " + _node["name"])
            for _par in _pars:
                try:
                    _pname = _par.name
                except Exception:
                    continue
                _entry = {}
                # Evaluated value — some pars raise on eval() (e.g. disconnected references).
                try:
                    _entry["value"] = _par.eval()
                except Exception as _ve:
                    report["warnings"].append(
                        "Could not eval " + _node["name"] + "." + _pname + ": " + str(_ve)
                    )
                # Mode; normalize "ParMode.CONSTANT" -> "CONSTANT".
                try:
                    _raw_mode = _par.mode
                    _entry["mode"] = (
                        str(_raw_mode).split(".")[-1].upper() if _raw_mode is not None else "UNKNOWN"
                    )
                except Exception:
                    _entry["mode"] = "UNKNOWN"
                # Raw expression string — only meaningful when mode is EXPRESSION.
                try:
                    _expr = _par.expr
                    if _expr:
                        _entry["expr"] = str(_expr)
                except Exception:
                    pass
                _node["params"][_pname] = _entry
            # Input wires by SOURCE NAME. A wire from outside root cannot be rebuilt.
            try:
                _conns = _o.inputConnectors
            except Exception:
                _conns = []
            for _ic in _conns:
                try:
                    _in_index = _ic.index
                except Exception:
                    _in_index = 0
                try:
                    _wires = _ic.connections
                except Exception:
                    _wires = []
                for _oc in _wires:
                    try:
                        _src = _oc.owner
                        _src_name = _src.name
                        _out_index = _oc.index
                    except Exception:
                        report["warnings"].append(
                            "Could not read an input wire on " + _node["name"]
                        )
                        continue
                    if _src_name not in _names:
                        report["warnings"].append(
                            "Input of "
                            + _node["name"]
                            + " comes from '"
                            + str(_src_name)
                            + "' outside the root; rebuild cannot recreate this cross-root wire."
                        )
                        continue
                    _node["inputs"].append(
                        {"from": _src_name, "out_index": _out_index, "in_index": _in_index}
                    )
            # Custom-parameter definitions (best-effort, UNVERIFIED shape) so rebuild can
            # recreate knobs. Guarded heavily — customPars may not exist on every build.
            if _include_custom:
                try:
                    _custom = _o.customPars
                except Exception:
                    _custom = []
                if _custom:
                    _defs = []
                    for _cp in _custom:
                        _d = {}
                        try:
                            _d["name"] = _cp.name
                        except Exception:
                            continue
                        try:
                            _d["page"] = str(_cp.page.name)
                        except Exception:
                            pass
                        try:
                            _d["style"] = str(_cp.style)
                        except Exception:
                            pass
                        try:
                            _d["default"] = _cp.default
                        except Exception:
                            pass
                        _defs.append(_d)
                    if _defs:
                        _node["custom_params"] = _defs
            report["nodes"].append(_node)
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildSerializeNetworkScript(payload: object): string {
  return buildPayloadScript(SERIALIZE_NETWORK_SCRIPT, payload);
}

export async function serializeNetworkImpl(ctx: ToolContext, args: SerializeNetworkArgs) {
  return guardTd(
    async () => {
      const script = buildSerializeNetworkScript({
        path: args.path,
        max_nodes: args.max_nodes,
        include_custom_params: args.include_custom_params,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<SerializeNetworkReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`serialize_network failed: ${report.fatal}`, report);
      }
      const wireCount = report.nodes.reduce((sum, n) => sum + n.inputs.length, 0);
      const summary = `Serialized ${report.nodes.length} node(s) under ${report.root} (${wireCount} wire(s))${
        report.truncated ? ", truncated" : ""
      }.`;
      return structuredResult(summary, {
        root: report.root,
        nodes: report.nodes,
        truncated: report.truncated,
        warnings: report.warnings,
      });
    },
  );
}

export const registerSerializeNetwork: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "serialize_network",
    {
      title: "Serialize network to diffable JSON",
      description:
        "Read-only: serialize a COMP's immediate children into a git-diffable JSON spec — each node's name, op type, parameters (with mode + expression, not just the evaluated value), input wires by source node name, and position — plus best-effort custom-parameter definitions. This is the serialize half of a round-trip pair: feed the output spec to rebuild_network to reconstruct the subtree. Use it to snapshot a network as text you can diff across edits or commit to version control. Returns {root, nodes[], truncated?, warnings[]}.",
      inputSchema: serializeNetworkSchema.shape,
      outputSchema: serializeNetworkOutputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    (args) => serializeNetworkImpl(ctx, args),
  );
};
