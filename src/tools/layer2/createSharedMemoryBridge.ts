import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const formatSchema = z
  .object({
    width: z.coerce.number().int().positive().optional().describe("(TOP) buffer width in pixels."),
    height: z.coerce
      .number()
      .int()
      .positive()
      .optional()
      .describe("(TOP) buffer height in pixels."),
    pixelFormat: z
      .enum(["rgba8", "rgba16", "rgba16f", "rgba32f", "mono8", "mono16f", "mono32f"])
      .optional()
      .describe("(TOP) pixel format — best-effort mapping to the operator's menu."),
    numChannels: z.coerce
      .number()
      .int()
      .positive()
      .optional()
      .describe("(CHOP, out) channel count when the operator wants it pinned."),
    sampleRate: z.coerce
      .number()
      .positive()
      .optional()
      .describe("(CHOP) sample rate for time-series data."),
    header: z
      .boolean()
      .default(true)
      .describe(
        "Include the TD header block in the segment (`header` par). When false, the peer reads a raw headerless buffer of exact size — easy to garble.",
      ),
  })
  .optional()
  .describe("Optional format hints. Unknown / unsupported pars on this build become warnings.");

export const createSharedMemoryBridgeSchema = z.object({
  direction: z
    .enum(["in", "out"])
    .describe("'in' = receive from an external app; 'out' = publish to an external app."),
  kind: z
    .enum(["TOP", "CHOP"])
    .describe("TOP = pixel buffer (RGBA frames); CHOP = numeric channels (control / audio-rate)."),
  shmName: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_.-]+$/, "ASCII letters/digits/_.- only, no spaces")
    .describe(
      "Shared-memory segment name. Must match exactly on both sides. Two TDs using the same name will collide.",
    ),
  parent: z.string().default("/project1").describe("COMP path to create the operator in."),
  name: z
    .string()
    .optional()
    .describe("Operator name; auto-generated when omitted (e.g. shm_in / shm_out)."),
  format: formatSchema,
});
type CreateSharedMemoryBridgeArgs = z.infer<typeof createSharedMemoryBridgeSchema>;

interface ShmReport {
  direction: "in" | "out";
  kind: "TOP" | "CHOP";
  node?: string;
  type?: string;
  shmName?: string;
  errors?: string[];
  warnings: string[];
  fatal?: string;
}

// One Python pass creates the right Shared Memory operator per (direction, kind), with
// defensive getattr() on the optypes because shared-memory ops are renamed/relocated
// across TD builds and are not universally available on every platform — a missing
// optype returns a friendly fatal rather than crashing. Unknown pars become warnings.
const SHM_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"direction": _p["direction"], "kind": _p["kind"], "warnings": []}
_TYPEMAP = {
    ("in","TOP"):  getattr(td, "sharedmemoryinTOP",  None),
    ("in","CHOP"): getattr(td, "sharedmemoryinCHOP", None),
    ("out","TOP"): getattr(td, "sharedmemoryoutTOP", None),
    ("out","CHOP"):getattr(td, "sharedmemoryoutCHOP",None),
}
_PIXFMT = {"rgba8":"rgba8fixed","rgba16":"rgba16fixed","rgba16f":"rgba16float","rgba32f":"rgba32float","mono8":"mono8fixed","mono16f":"mono16float","mono32f":"mono32float"}
try:
    _parent = op(_p["parent"])
    if _parent is None:
        report["fatal"] = "Parent COMP not found: " + str(_p["parent"])
    else:
        _optype = _TYPEMAP.get((_p["direction"], _p["kind"]))
        if _optype is None:
            report["fatal"] = "Shared Memory %s %s is not available on this TouchDesigner build/platform." % (_p["direction"], _p["kind"])
        else:
            _name = _p.get("name")
            _node = _parent.create(_optype, _name) if _name else _parent.create(_optype)
            report["node"] = _node.path; report["type"] = _node.type
            def _setpar(parname, val):
                if val is None:
                    return
                pr = getattr(_node.par, parname, None)
                if pr is None:
                    report["warnings"].append("No parameter '%s' on %s" % (parname, _node.type)); return
                try:
                    pr.val = val
                except Exception:
                    report["warnings"].append("Could not set parameter '%s'" % parname)
            fmt = _p.get("format") or {}
            _setpar("shmname", _p["shmName"])
            _setpar("header",  bool(fmt.get("header", True)))
            if _p["kind"] == "TOP":
                _setpar("resolutionw", fmt.get("width"))
                _setpar("resolutionh", fmt.get("height"))
                _pf = fmt.get("pixelFormat")
                if _pf is not None:
                    _mapped = _PIXFMT.get(_pf)
                    if _mapped is None:
                        report["warnings"].append("Unknown pixelFormat '%s' — kept operator default." % _pf)
                    else:
                        _setpar("pixelformat", _mapped)
            else:
                _setpar("rate", fmt.get("sampleRate"))
                _setpar("numchannels", fmt.get("numChannels"))
            report["shmName"] = _p["shmName"]
            report["errors"] = [str(e) for e in _node.errors()][:3]
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildShmScript(payload: object): string {
  return buildPayloadScript(SHM_SCRIPT, payload);
}

export async function createSharedMemoryBridgeImpl(
  ctx: ToolContext,
  args: CreateSharedMemoryBridgeArgs,
) {
  return guardTd(
    async () => {
      const script = buildShmScript({
        direction: args.direction,
        kind: args.kind,
        shmName: args.shmName,
        parent: args.parent,
        name: args.name ?? null,
        format: args.format ?? {},
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<ShmReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(
          `Could not create Shared Memory ${report.direction} ${report.kind}: ${report.fatal}`,
          report,
        );
      }
      const errs = report.errors?.length ? `, ${report.errors.length} node error(s)` : "";
      const warns = report.warnings.length ? `, ${report.warnings.length} warning(s)` : "";
      return jsonResult(
        `Created Shared Memory ${report.direction} ${report.kind} (${report.type}) at ${report.node} on segment '${report.shmName}'${errs}${warns}.`,
        report,
      );
    },
  );
}

export const registerCreateSharedMemoryBridge: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_shared_memory_bridge",
    {
      title: "Create Shared Memory bridge",
      description:
        "Create a Shared Memory In/Out TOP/CHOP for zero-copy IPC with another app on the same host (Notch, Unity, Unreal, custom tools). Pick direction ('in' to receive, 'out' to publish), kind (TOP for pixel buffers, CHOP for numeric channels), and a shmName that the peer must match exactly. After creating an Out variant, wire the producer TOP/CHOP into it with connect_nodes. When format.header=false the peer reads a raw headerless buffer — sizes must agree exactly or frames will garble. Some (direction, kind) combos are platform/build-dependent; the tool returns a friendly fatal if the optype isn't available.",
      inputSchema: createSharedMemoryBridgeSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createSharedMemoryBridgeImpl(ctx, args),
  );
};
