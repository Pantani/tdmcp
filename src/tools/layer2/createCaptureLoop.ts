import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const createCaptureLoopSchema = z.object({
  parent_path: z
    .string()
    .default("/project1")
    .describe("COMP to build the capture-loop container in (e.g. '/project1')."),
  name: z
    .string()
    .default("capture_loop")
    .describe("Base name for the container COMP that holds the in/out bridge."),
  protocol: z
    .enum(["spout", "syphon", "ndi"])
    .default("ndi")
    .describe(
      "Inter-app video transport. ndi works on macOS & Windows (network). spout is Windows-only; syphon is macOS-only — both use the same Syphon/Spout TOPs in TouchDesigner (PLATFORM-GATED: the wrong platform fails to create the op, reported as a warning).",
    ),
  direction: z
    .enum(["in", "out", "both"])
    .default("both")
    .describe(
      "in: only receive an external feed. out: only publish a TOP. both: do both at once (a full round-trip loop to another app, e.g. send to Resolume and receive its output back).",
    ),
  sender_name: z
    .string()
    .default("tdmcp_out")
    .describe(
      "(out) The public name THIS app publishes its feed under, so the other app can find it. Used for direction 'out'/'both'.",
    ),
  receiver_name: z
    .string()
    .default("")
    .describe(
      "(in) The name of the EXTERNAL sender to subscribe to. Empty = pick the first available sender on the network/machine. Used for direction 'in'/'both'.",
    ),
  source_top: z
    .string()
    .default("")
    .describe(
      "(out) Path of the TOP to publish when direction includes 'out' (e.g. '/project1/final'). Empty together with an 'out' direction publishes nothing and is flagged as a warning.",
    ),
  resolution: z
    .array(z.number())
    .length(2)
    .default([1280, 720])
    .describe(
      "Working resolution [w, h] applied to the receiver TOP (Output Resolution = Custom). The publisher inherits its input TOP's resolution.",
    ),
});
type CreateCaptureLoopArgs = z.infer<typeof createCaptureLoopSchema>;

interface CaptureLoopReport {
  container: string;
  in_top: string;
  out_top: string;
  protocol: string;
  direction: string;
  warnings: string[];
  fatal?: string;
}

// One Python pass builds a baseCOMP holding a bidirectional inter-app video bridge.
//
// Operator names are KB-confirmed (src/knowledge/data/operators) and match the
// repo's existing builders (createLiveSource.ts / setupOutput.ts):
//   IN  : ndiinTOP (ndi) | syphonspoutinTOP (syphon/spout share one in-TOP)
//   OUT : ndioutTOP (ndi) | syphonspoutoutTOP (syphon/spout share one out-TOP)
//   selectTOP.par.top picks the source TOP without a cross-container wire;
//   nullTOP is a stable output handle.
//
// Sender/receiver-name parameter names vary by TD build, so we PROBE a list of
// candidate spellings and set the first that exists (mirroring createLiveSource.ts
// / setupOutput.ts / createExternalIo.ts). KB labels: NDI in/out → "Source Name"
// (par 'sourcename'); Syphon/Spout in/out → "Sender Name" (par 'sendername'). We
// keep 'name'/'sender' as fallbacks for build variance. selectTOP → "TOP" (par
// 'top'). Every create + par-set is guarded; per-item failures go to
// report["warnings"] (PLATFORM-GATED: spout=Windows, syphon=macOS, ndi=both — the
// wrong platform fails to create the op and is reported as a warning, not a
// fatal). report["fatal"] is reserved for the parent COMP being missing — i.e.
// nothing could be built at all.
//
// ANTI-FEEDBACK: for direction "both" the receiver TOP is NEVER wired into the
// publish path — that would loop this app's own output straight back in and storm.
// The two halves stay completely separate.
const CAPTURE_LOOP_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {
    "container": "",
    "in_top": "",
    "out_top": "",
    "protocol": _p["protocol"],
    "direction": _p["direction"],
    "warnings": [],
}

def _setpar_first(_node, _names, _val, _label, _warns):
    # Set the first parameter in _names that exists on _node; warn if none do.
    for _pn in _names:
        pr = getattr(_node.par, _pn, None)
        if pr is not None:
            try:
                pr.val = _val
                return True
            except Exception:
                _warns.append("Could not set %s (par '%s')." % (_label, _pn))
                return False
    _warns.append("No %s parameter found (tried %s) - build-dependent." % (_label, ", ".join(_names)))
    return False

try:
    _proto = _p["protocol"]
    _dir = _p["direction"]
    _res = _p.get("resolution") or []
    _parent = op(_p["parent_path"])
    if _parent is None:
        report["fatal"] = "Parent COMP not found: " + str(_p["parent_path"])
    else:
        try:
            _cont = _parent.create(baseCOMP, _p["name"])
        except Exception as _e:
            report["fatal"] = "Could not create container: " + str(_e)
            _cont = None

        if _cont is not None:
            report["container"] = _cont.path

            # In-op / out-op type per protocol. Syphon & Spout share one in/out TOP
            # on TouchDesigner; only one of them is functional per platform.
            _in_types = {"ndi": "ndiinTOP", "syphon": "syphonspoutinTOP", "spout": "syphonspoutinTOP"}
            _out_types = {"ndi": "ndioutTOP", "syphon": "syphonspoutoutTOP", "spout": "syphonspoutoutTOP"}
            # Probe order for the receiver/publisher name par (NDI uses 'sourcename',
            # Syphon/Spout uses 'sendername'; the rest are build-variance fallbacks).
            _ndi_names = ["sourcename", "name", "source"]
            _syp_names = ["sendername", "name", "sender"]
            _name_pars = _ndi_names if _proto == "ndi" else _syp_names

            # ---------- IN: receive an external feed ----------
            if _dir in ("in", "both"):
                _in_optype = globals().get(_in_types[_proto])
                if _in_optype is None:
                    report["warnings"].append(
                        "%s in-TOP (%s) not available on this build/platform - receive half skipped."
                        % (_proto, _in_types[_proto])
                    )
                else:
                    _recv = None
                    try:
                        _recv = _cont.create(_in_optype, "recv")
                    except Exception as _e:
                        report["warnings"].append(
                            "Could not create %s in-TOP (%s) - platform-gated." % (_proto, str(_e))
                        )
                    if _recv is not None:
                        # The sender to subscribe to. Empty = first available; only
                        # set the name when one was given.
                        _rn = _p.get("receiver_name") or ""
                        if _rn:
                            _setpar_first(
                                _recv, _name_pars, _rn, "receiver/sender name", report["warnings"]
                            )
                        # Optional working resolution where the op supports a custom one.
                        if len(_res) == 2:
                            _rw = getattr(_recv.par, "resolutionw", None)
                            _rh = getattr(_recv.par, "resolutionh", None)
                            if _rw is not None and _rh is not None:
                                try:
                                    _outres = getattr(_recv.par, "outputresolution", None)
                                    if _outres is not None:
                                        _outres.val = "custom"
                                    _rw.val = int(_res[0])
                                    _rh.val = int(_res[1])
                                except Exception:
                                    report["warnings"].append(
                                        "Could not apply custom resolution to the receiver."
                                    )
                        # Null as a stable handle for the incoming feed.
                        try:
                            _innull = _cont.create(nullTOP, "in_out")
                            _innull.inputConnectors[0].connect(_recv)
                            report["in_top"] = _innull.path
                        except Exception as _e:
                            report["in_top"] = _recv.path
                            report["warnings"].append("In Null TOP failed: " + str(_e))

            # ---------- OUT: publish a TOP ----------
            if _dir in ("out", "both"):
                _src_path = _p.get("source_top") or ""
                if not _src_path:
                    report["warnings"].append(
                        "direction includes 'out' but source_top is empty - nothing is being published."
                    )
                _out_optype = globals().get(_out_types[_proto])
                if _out_optype is None:
                    report["warnings"].append(
                        "%s out-TOP (%s) not available on this build/platform - send half skipped."
                        % (_proto, _out_types[_proto])
                    )
                else:
                    # Pull the source by path through a Select TOP (no cross-container
                    # wire). ANTI-FEEDBACK: never route the receiver into this path.
                    _feed = None
                    if _src_path:
                        try:
                            _sel = _cont.create(selectTOP, "src")
                            _setpar_first(_sel, ["top"], _src_path, "select source TOP", report["warnings"])
                            _feed = _sel
                        except Exception as _e:
                            report["warnings"].append("Select TOP failed: " + str(_e))
                    _send = None
                    try:
                        _send = _cont.create(_out_optype, "send")
                    except Exception as _e:
                        report["warnings"].append(
                            "Could not create %s out-TOP (%s) - platform-gated." % (_proto, str(_e))
                        )
                    if _send is not None:
                        if _feed is not None:
                            try:
                                _send.inputConnectors[0].connect(_feed)
                            except Exception:
                                report["warnings"].append("Could not connect source TOP to the publisher.")
                        # Public publish name.
                        _sn = _p.get("sender_name") or _send.name
                        _setpar_first(_send, _name_pars, _sn, "publish/sender name", report["warnings"])
                        report["out_top"] = _send.path
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildCaptureLoopScript(payload: object): string {
  return buildPayloadScript(CAPTURE_LOOP_SCRIPT, payload);
}

export async function createCaptureLoopImpl(ctx: ToolContext, args: CreateCaptureLoopArgs) {
  return guardTd(
    async () => {
      const script = buildCaptureLoopScript({
        parent_path: args.parent_path,
        name: args.name,
        protocol: args.protocol,
        direction: args.direction,
        sender_name: args.sender_name,
        receiver_name: args.receiver_name,
        source_top: args.source_top,
        resolution: args.resolution,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<CaptureLoopReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`Capture-loop build failed: ${report.fatal}`, report);
      }
      const halves: string[] = [];
      if (report.in_top) halves.push(`in ${report.in_top}`);
      if (report.out_top) halves.push(`out ${report.out_top}`);
      const halvesNote = halves.length > 0 ? ` (${halves.join(", ")})` : "";
      const warnNote = report.warnings.length > 0 ? `, ${report.warnings.length} warning(s)` : "";
      const summary = `Built a ${report.protocol} ${report.direction} capture loop at ${report.container}${halvesNote}${warnNote}.`;
      return jsonResult(summary, report);
    },
  );
}

export const registerCreateCaptureLoop: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_capture_loop",
    {
      title: "Create capture loop",
      description:
        "Build a bidirectional inter-app video bridge to another program (Resolume, OBS, MadMapper, a game engine…) in one container: receive an external feed IN and publish a TOP OUT at the same time. Picks the right operators per protocol — NDI (network, macOS & Windows), or Syphon (macOS) / Spout (Windows). direction 'in' only subscribes, 'out' only publishes, 'both' runs a full round-trip loop. The receive half is a receiver TOP → Null 'in_out'; the send half pulls source_top through a Select TOP into a publisher TOP. ANTI-FEEDBACK: the two halves are never wired together, so 'both' won't loop this app's own output back in. PLATFORM-GATED & largely UNVERIFIED-live: Spout needs Windows, Syphon needs macOS, and sender/receiver-name parameter names vary by TD build (probed at runtime) — the wrong platform or a real signal needs the actual sender present. This is the combined in+out version of create_live_source (in) and setup_output (out).",
      inputSchema: createCaptureLoopSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createCaptureLoopImpl(ctx, args),
  );
};
