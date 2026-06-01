import { z } from "zod";
import { friendlyTdError } from "../../td-client/types.js";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

/**
 * `swap_operator` — change an operator's TYPE in place: snapshot incoming +
 * outgoing connectors and any matching parameters, delete the old node, create
 * a new node of the new type at the SAME PARENT with the SAME NAME, re-wire,
 * and re-apply any parameters that exist on the new type. Failures during
 * rewire are reported as warnings (fail-forward); a fatal at the create step
 * surfaces as an error result and the old node is restored only if we never
 * deleted it. Single Python pass so the swap is as atomic as TD allows.
 */

export const swapOperatorSchema = z.object({
  node_path: z.string().describe("Path of the node to swap (e.g. '/project1/noise1')."),
  new_type: z.string().describe("New operator type, e.g. 'rampTOP', 'constantCHOP'."),
  preserve_parameters: z
    .boolean()
    .default(true)
    .describe("Re-apply parameters that exist (by name) on the new type."),
});
export type SwapOperatorArgs = z.infer<typeof swapOperatorSchema>;

interface SwapReport {
  node_path: string;
  new_type: string;
  old_type?: string;
  new_path?: string;
  preserved_parameters?: string[];
  dropped_parameters?: string[];
  reconnected_inputs?: number;
  reconnected_outputs?: number;
  failed_inputs?: string[];
  failed_outputs?: string[];
  warnings?: string[];
  fatal?: string;
}

const SWAP_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {
    "node_path": _p["node_path"],
    "new_type": _p["new_type"],
    "preserved_parameters": [],
    "dropped_parameters": [],
    "reconnected_inputs": 0,
    "reconnected_outputs": 0,
    "failed_inputs": [],
    "failed_outputs": [],
    "warnings": [],
}
try:
    _old = op(_p["node_path"])
    if _old is None:
        report["fatal"] = "Node not found: " + _p["node_path"]
    else:
        _parent = _old.parent()
        if _parent is None:
            report["fatal"] = "Cannot swap a root node: " + _p["node_path"]
        else:
            report["old_type"] = _old.OPType
            _name = _old.name
            _x = _old.nodeX
            _y = _old.nodeY

            # Snapshot input wires: list of (source_path, source_output_index, target_input_index)
            _in_snapshot = []
            try:
                for _i, _ic in enumerate(_old.inputConnectors):
                    for _oc in _ic.connections:
                        _src = _oc.owner
                        try:
                            _src_out = list(_src.outputConnectors).index(_oc)
                        except Exception:
                            _src_out = 0
                        _in_snapshot.append((_src.path, _src_out, _i))
            except Exception as _e:
                report["warnings"].append("input snapshot partial: " + str(_e))

            # Snapshot output wires: list of (target_path, target_input_index, source_output_index)
            _out_snapshot = []
            try:
                for _o, _oc in enumerate(_old.outputConnectors):
                    for _ic in _oc.connections:
                        _tgt = _ic.owner
                        try:
                            _tgt_in = list(_tgt.inputConnectors).index(_ic)
                        except Exception:
                            _tgt_in = 0
                        _out_snapshot.append((_tgt.path, _tgt_in, _o))
            except Exception as _e:
                report["warnings"].append("output snapshot partial: " + str(_e))

            # Snapshot parameters (custom + tuplet-aware native).
            _param_snapshot = {}
            if _p.get("preserve_parameters", True):
                try:
                    for _par in _old.pars():
                        try:
                            _param_snapshot[_par.name] = _par.eval()
                        except Exception:
                            pass
                except Exception:
                    pass

            # Delete the old node.
            try:
                _old.destroy()
            except Exception as _e:
                report["fatal"] = "Could not delete old node: " + str(_e)
                raise Exception("destroy failed")

            # Create the new node at the same parent + name + position.
            try:
                _new = _parent.create(_p["new_type"], _name)
            except Exception as _e:
                report["fatal"] = "Could not create replacement (" + _p["new_type"] + "): " + str(_e)
                raise Exception("create failed")
            try:
                _new.nodeX = _x
                _new.nodeY = _y
            except Exception:
                pass
            report["new_path"] = _new.path

            # Re-apply matching parameters.
            for _name_p, _val in _param_snapshot.items():
                _par = getattr(_new.par, _name_p, None)
                if _par is None:
                    report["dropped_parameters"].append(_name_p)
                    continue
                try:
                    _par.val = _val
                    report["preserved_parameters"].append(_name_p)
                except Exception:
                    report["dropped_parameters"].append(_name_p)

            # Rewire inputs.
            for _src_path, _src_out, _tgt_in in _in_snapshot:
                _src = op(_src_path)
                if _src is None:
                    report["failed_inputs"].append(_src_path + " (source gone)")
                    continue
                try:
                    _new.inputConnectors[_tgt_in].connect(_src.outputConnectors[_src_out])
                    report["reconnected_inputs"] += 1
                except Exception as _e:
                    report["failed_inputs"].append(_src_path + ": " + str(_e))

            # Rewire outputs.
            for _tgt_path, _tgt_in, _src_out in _out_snapshot:
                _tgt = op(_tgt_path)
                if _tgt is None:
                    report["failed_outputs"].append(_tgt_path + " (target gone)")
                    continue
                try:
                    _tgt.inputConnectors[_tgt_in].connect(_new.outputConnectors[_src_out])
                    report["reconnected_outputs"] += 1
                except Exception as _e:
                    report["failed_outputs"].append(_tgt_path + ": " + str(_e))
except Exception:
    if not report.get("fatal"):
        report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export async function swapOperatorImpl(ctx: ToolContext, args: SwapOperatorArgs) {
  // Soft validate the requested type against the KB.
  const warnings: string[] = [];
  if (!ctx.knowledge.operatorExists(args.new_type)) {
    const suggestions = ctx.knowledge.searchOperators(args.new_type, 3).map((s) => s.name);
    warnings.push(
      `Operator type "${args.new_type}" was not found in the knowledge base.${
        suggestions.length ? ` Did you mean: ${suggestions.join(", ")}?` : ""
      }`,
    );
  }
  try {
    const exec = await ctx.client.executePythonScript(
      buildPayloadScript(SWAP_SCRIPT, {
        node_path: args.node_path,
        new_type: args.new_type,
        preserve_parameters: args.preserve_parameters,
      }),
      true,
    );
    const report = parsePythonReport<SwapReport>(exec.stdout);
    const allWarnings = [...warnings, ...(report.warnings ?? [])];
    if (report.fatal) {
      return errorResult(`Swap failed: ${report.fatal}`, { ...report, warnings: allWarnings });
    }
    return jsonResult(
      `Swapped ${args.node_path} ${report.old_type} → ${args.new_type} (${report.preserved_parameters?.length ?? 0} params kept, ${report.reconnected_inputs ?? 0}+${report.reconnected_outputs ?? 0} wires).`,
      { ...report, warnings: allWarnings },
    );
  } catch (err) {
    return errorResult(friendlyTdError(err));
  }
}

export const registerSwapOperator: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "swap_operator",
    {
      title: "Swap an operator's type in place",
      description:
        "Change an operator's TYPE while preserving its name, position, incoming + outgoing wires, and any parameters that exist on the new type. Snapshots wires + params, deletes the old node, creates a new node of `new_type` at the same parent/name/x/y, re-applies matching params (others go into `dropped_parameters`), and rewires connectors. Fail-forward: per-wire / per-param failures are reported as `failed_inputs[]` / `failed_outputs[]` / `dropped_parameters[]` rather than aborting. Returns `{old_type, new_path, preserved_parameters, dropped_parameters, reconnected_inputs, reconnected_outputs, failed_inputs, failed_outputs, warnings}`.",
      inputSchema: swapOperatorSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    (args) => swapOperatorImpl(ctx, args),
  );
};
