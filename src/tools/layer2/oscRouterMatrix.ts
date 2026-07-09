import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const oscRouteSchema = z.object({
  address: z
    .string()
    .regex(/^\/?[A-Za-z0-9_.~/-]+$/, "OSC address must be slash-safe ASCII")
    .describe("OSC address or address tail. A leading slash is optional."),
  channel: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Channel must be a Constant CHOP-safe name")
    .optional()
    .describe("Optional local Constant CHOP channel name. Defaults from the address tail."),
  label: z.string().optional().describe("Human label stored in the returned route report."),
  default: z.coerce.number().default(0).describe("Initial value sent for this route."),
});

export const oscTargetSchema = z.object({
  name: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Target name must be node-name safe")
    .describe("Target label and node suffix, e.g. qlab, resolume, atem."),
  host: z.string().default("127.0.0.1").describe("OSC destination host/IP."),
  port: z.coerce.number().int().min(1).max(65535).describe("OSC destination UDP port."),
  prefix: z
    .string()
    .regex(/^\/?[A-Za-z0-9_.~/-]*$/, "Prefix must be slash-safe ASCII")
    .default("")
    .describe("Optional prefix prepended to every route address for this target."),
  active: z.boolean().default(false).describe("Start the OSC Out CHOP active immediately."),
});

export const oscRouterMatrixSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP to build the router in."),
  name: z.string().default("osc_router_matrix").describe("Name of the router container COMP."),
  routes: z
    .array(oscRouteSchema)
    .min(1)
    .max(16)
    .describe("Routes/channels to create for every target."),
  targets: z
    .array(oscTargetSchema)
    .min(1)
    .max(8)
    .describe("OSC destinations. Each target gets a Constant CHOP and OSC Out CHOP."),
});
export type OscRouterMatrixArgs = z.infer<typeof oscRouterMatrixSchema>;

interface OscRouterReport {
  container?: string;
  targets: Array<{
    name: string;
    host: string;
    port: number;
    source?: string;
    osc_out?: string;
    addresses: string[];
  }>;
  routes: Array<{ address: string; channel: string; label?: string; default: number }>;
  warnings: string[];
  fatal?: string;
}

function cleanAddress(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
}

function joinAddress(prefix: string, address: string): string {
  const head = cleanAddress(prefix);
  const tail = cleanAddress(address);
  return [head, tail].filter(Boolean).join("/");
}

export function defaultOscChannel(address: string): string {
  const last = cleanAddress(address).split("/").filter(Boolean).at(-1) ?? "value";
  const safe = last.replace(/[^A-Za-z0-9_]/g, "_");
  const seeded = /^[A-Za-z_]/.test(safe) ? safe : `v_${safe}`;
  return seeded || "value";
}

const OSC_ROUTER_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"targets": [], "routes": list(_p["routes"]), "warnings": []}

def _safe_name(value):
    out = "".join(ch if ch.isalnum() or ch == "_" else "_" for ch in str(value))
    if not out or not (out[0].isalpha() or out[0] == "_"):
        out = "t_" + out
    return out

def _place(node, x, y):
    try:
        node.nodeX = x
        node.nodeY = y
    except Exception:
        pass

def _setpar(node, name, value):
    try:
        par = getattr(node.par, name, None)
        if par is not None:
            par.val = value
            return True
        report["warnings"].append("No parameter %s on %s" % (name, node.path))
    except Exception:
        report["warnings"].append("Could not set %s on %s" % (name, node.path))
    return False

try:
    parent = op(_p["parent_path"])
    if parent is None:
        report["fatal"] = "Parent COMP not found: " + str(_p["parent_path"])
    elif not hasattr(parent, "create"):
        report["fatal"] = str(_p["parent_path"]) + " is not a COMP."
    else:
        container = parent.op(_p["name"]) or parent.create(baseCOMP, _p["name"])
        report["container"] = container.path
        for ti, target in enumerate(_p["targets"]):
            tname = _safe_name(target["name"])
            source = container.op("controls_" + tname) or container.create(constantCHOP, "controls_" + tname)
            osc = container.op("osc_" + tname) or container.create(oscoutCHOP, "osc_" + tname)
            _place(source, 0, -ti * 120)
            _place(osc, 220, -ti * 120)
            addresses = []
            for ri, route in enumerate(_p["routes"]):
                channel = route["target_channels"][target["name"]]
                _setpar(source, "name%d" % ri, channel)
                _setpar(source, "value%d" % ri, float(route.get("default", 0)))
                addresses.append("/" + channel)
            _setpar(osc, "netaddress", target["host"])
            _setpar(osc, "port", int(target["port"]))
            _setpar(osc, "active", 1 if target.get("active") else 0)
            try:
                osc.inputConnectors[0].connect(source)
            except Exception:
                report["warnings"].append("Could not connect %s to %s" % (source.path, osc.path))
            report["targets"].append({"name": target["name"], "host": target["host"], "port": int(target["port"]), "source": source.path, "osc_out": osc.path, "addresses": addresses})
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function normalizeOscRouterArgs(args: OscRouterMatrixArgs): OscRouterMatrixArgs {
  const routes = args.routes.map((route) => {
    const targetChannels = Object.fromEntries(
      args.targets.map((target) => [
        target.name,
        joinAddress(target.prefix, route.address || route.channel || "value"),
      ]),
    );
    return {
      ...route,
      address: route.address.startsWith("/") ? route.address : `/${route.address}`,
      channel: route.channel ?? defaultOscChannel(route.address),
      target_channels: targetChannels,
    };
  });
  return { ...args, routes } as OscRouterMatrixArgs;
}

export function buildOscRouterMatrixScript(payload: object): string {
  return buildPayloadScript(OSC_ROUTER_SCRIPT, payload);
}

export async function oscRouterMatrixImpl(ctx: ToolContext, args: OscRouterMatrixArgs) {
  const normalized = normalizeOscRouterArgs(args);
  return guardTd(
    async () => {
      const script = buildOscRouterMatrixScript(normalized);
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<OscRouterReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal)
        return errorResult(`Could not build OSC router matrix: ${report.fatal}`, report);
      const addresses = report.targets.flatMap((target) => target.addresses);
      const summary = `Built OSC router matrix ${report.container} with ${report.routes.length} route(s) to ${report.targets.length} target(s): ${addresses.slice(0, 4).join(", ")}${addresses.length > 4 ? " ..." : ""}${
        report.warnings.length ? `, ${report.warnings.length} warning(s)` : ""
      }.`;
      return jsonResult(summary, report);
    },
  );
}

export const registerOscRouterMatrix: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "osc_router_matrix",
    {
      title: "OSC router matrix",
      description:
        "Create an offline-safe OSC control matrix: one Constant CHOP plus OSC Out CHOP per target, deterministic left-to-right layout, target-specific address prefixes, and a structured report of every emitted OSC address. Use it as the primitive for QLab, atemOSC/Companion, Resolume, VDMX, or any OSC-speaking show-control endpoint.",
      inputSchema: oscRouterMatrixSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => oscRouterMatrixImpl(ctx, args),
  );
};
