import { z } from "zod";
import { isMissingEndpoint } from "../../td-client/types.js";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const disconnectNodesSchema = z.object({
  to_path: z.string().describe("The downstream node to remove input wire(s) from."),
  from_path: z
    .string()
    .optional()
    .describe(
      "Only remove wires coming from this upstream node. Omit to remove ALL input wires into to_path (scoped by to_input if given).",
    ),
  to_input: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Only clear this input index on to_path (0-based). Omit to clear all inputs."),
});
type DisconnectNodesArgs = z.infer<typeof disconnectNodesSchema>;

interface RemovedWire {
  input: number;
  from: string;
}

interface DisconnectReport {
  to_path: string;
  from_path: string | null;
  to_input: number | null;
  removed: RemovedWire[];
  probe: {
    connector_attrs: string[];
    has_disconnect: boolean;
    conn_attrs?: string[];
    owner_attr?: string;
  } | null;
  warnings: string[];
  fatal?: string;
}

// Removes wires from a node's input connectors.
//
// TD's inputConnectors is an indexed list of Connector objects. Each connector's
// `.connections` property returns the list of upstream connections. We iterate
// connectors, optionally filter by index and upstream path, then call disconnect()
// on the upstream Connector object (conn) for a targeted single-wire removal, or
// on the input connector itself as a fallback that clears all wires into that slot.
//
// UNVERIFIED assumptions (TD offline):
//   - `op(_to_path).inputConnectors[i]` — exists on all OP types (tested on TOPs).
//   - `connector.connections` — list of upstream Connector objects for that input slot.
//   - `conn.owner` — the operator that owns the upstream connector.
//   - `conn.disconnect()` — disconnects the single wire represented by conn.
//   - `connector.disconnect()` — fallback that clears all wires into that input slot.
// The probe block captures dir() on the first connector so the lead can verify
// these attribute names on the first live run.
const DISCONNECT_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {
  "to_path": _p["to_path"],
  "from_path": _p.get("from_path"),
  "to_input": _p.get("to_input"),
  "removed": [],
  "probe": None,
  "warnings": [],
}
try:
  _to = op(_p["to_path"])
  if _to is None:
    report["fatal"] = "Node not found: " + str(_p["to_path"])
  else:
    _from_path = _p.get("from_path")
    _to_input = _p.get("to_input")
    _probe_done = False
    for i, connector in enumerate(_to.inputConnectors):
      if _to_input is not None and i != _to_input:
        continue
      # Probe the first connector's API so the lead can verify attribute names.
      if not _probe_done:
        try:
          _c_attrs = sorted([a for a in dir(connector) if not a.startswith("_")])
          _has_disconnect = hasattr(connector, "disconnect")
          report["probe"] = {
            "connector_attrs": _c_attrs,
            "has_disconnect": _has_disconnect,
          }
        except Exception as _pe:
          report["probe"] = {"connector_attrs": [], "has_disconnect": False, "probe_error": str(_pe)}
        _probe_done = True
      try:
        _conns = list(connector.connections)
      except Exception as _ce:
        report["warnings"].append("inputConnectors[" + str(i) + "].connections error: " + str(_ce))
        continue
      for conn in _conns:
        # Resolve the upstream operator — try conn.owner first, then conn.op.
        _src_op = None
        _owner_attr = None
        try:
          _src_op = conn.owner
          _owner_attr = "owner"
        except AttributeError:
          pass
        if _src_op is None:
          try:
            _src_op = conn.op
            _owner_attr = "op"
          except AttributeError:
            pass
        if _src_op is None:
          report["warnings"].append("Could not resolve upstream op for inputConnectors[" + str(i) + "]")
          continue
        if _probe_done and report["probe"] is not None and _owner_attr is not None:
          report["probe"]["owner_attr"] = _owner_attr
          try:
            report["probe"]["conn_attrs"] = sorted([a for a in dir(conn) if not a.startswith("_")])
          except Exception:
            pass
        if _from_path is not None and _src_op.path != _from_path:
          continue
        # Prefer conn.disconnect() for a single-wire removal; fall back to connector.disconnect().
        _disconnected = False
        try:
          conn.disconnect()
          _disconnected = True
        except Exception as _de1:
          try:
            connector.disconnect()
            _disconnected = True
          except Exception as _de2:
            report["warnings"].append(
              "disconnect failed for inputConnectors[" + str(i) + "] from " + str(_src_op.path)
              + ": conn.disconnect -> " + str(_de1) + "; connector.disconnect -> " + str(_de2)
            )
        if _disconnected:
          report["removed"].append({"input": i, "from": _src_op.path})
except Exception:
  report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildDisconnectScript(payload: object): string {
  return buildPayloadScript(DISCONNECT_SCRIPT, payload);
}

export async function disconnectNodesImpl(
  ctx: ToolContext,
  args: DisconnectNodesArgs,
): Promise<import("@modelcontextprotocol/sdk/types.js").CallToolResult> {
  return guardTd(
    async () => {
      // 1) first-class endpoint (survives ALLOW_EXEC=0). Same response shape as the
      //    exec path, minus the connector probe (absent on the structured route).
      try {
        const r = await ctx.client.disconnectNodes(args.to_path, args.from_path, args.to_input);
        return { ...r, probe: null } as DisconnectReport;
      } catch (err) {
        // Fall back ONLY when the endpoint is absent (older bridge). A current
        // bridge's validation 400 (e.g. to_path not found) must surface, not run
        // the exec path after the structured route already rejected the request.
        if (!isMissingEndpoint(err)) throw err;
      }
      const script = buildDisconnectScript({
        to_path: args.to_path,
        from_path: args.from_path ?? null,
        to_input: args.to_input ?? null,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<DisconnectReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`disconnect_nodes failed: ${report.fatal}`, report);
      }
      const k = report.removed.length;
      const scope = report.from_path ? ` from ${report.from_path}` : "";
      const inputScope = report.to_input != null ? ` (input ${report.to_input})` : "";
      const summary = `Removed ${k} wire(s) into ${report.to_path}${inputScope}${scope}.`;
      return jsonResult(summary, report);
    },
  );
}

export const registerDisconnectNodes: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "disconnect_nodes",
    {
      title: "Disconnect node wire(s)",
      description:
        "Remove one or more input wires from a node in TouchDesigner. By default removes every incoming wire into to_path; narrow the scope with from_path (only wires from that upstream node) and/or to_input (only that input slot index). Returns the list of removed wires (input index + upstream node path), a probe of the Connector API attributes seen at runtime, and any per-wire warnings. Fatal only when to_path is not found — partial removals with per-wire warnings still succeed. The inverse of connect_nodes.",
      inputSchema: disconnectNodesSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => disconnectNodesImpl(ctx, args),
  );
};
