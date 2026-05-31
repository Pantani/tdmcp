import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const createEngineCompSchema = z.object({
  name: z.string().default("engine1").describe("Node name for the new Engine COMP."),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP path the Engine COMP is created inside (default '/project1')."),
  tox_path: z
    .string()
    .describe(
      "Path to the .tox file the sub-engine loads. Forward-slash recommended; absolute or project-relative.",
    ),
  reload: z
    .boolean()
    .default(false)
    .describe(
      "When true, pulse the Engine COMP's reload par so the .tox is re-pulled once at creation.",
    ),
  use_color_map: z
    .boolean()
    .default(false)
    .describe(
      "Mirror the Engine COMP's color-map toggle (UNVERIFIED par name 'usecolormap' — guarded with hasattr).",
    ),
  perform_mode: z
    .enum(["auto", "on", "off"])
    .default("auto")
    .describe(
      "'on' forces the sub-engine to cook in perform mode; 'off' forces it off; 'auto' leaves the par at its default. (UNVERIFIED par name 'performmode' — guarded with hasattr).",
    ),
});

export type CreateEngineCompArgs = z.infer<typeof createEngineCompSchema>;

// ---------------------------------------------------------------------------
// Report interface
// ---------------------------------------------------------------------------

interface EngineCompReport {
  path: string;
  type: string;
  tox_path: string;
  warnings: string[];
  fatal?: string;
}

// ---------------------------------------------------------------------------
// Python bridge script
// ---------------------------------------------------------------------------

const ENGINE_COMP_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {
    "path": "",
    "type": "engineCOMP",
    "tox_path": _p["tox_path"],
    "warnings": [],
}
try:
    _parent = op(_p["parent_path"])
    if _parent is None or not getattr(_parent, "isCOMP", False):
        report["fatal"] = "Parent COMP not found: " + str(_p["parent_path"])
    else:
        _node = None
        try:
            _node = _parent.create(engineCOMP, _p["name"])
        except Exception as _e:
            report["fatal"] = "Could not create engineCOMP: " + str(_e)
            _node = None
        if _node is not None:
            report["path"] = _node.path
            try:
                report["type"] = _node.type
            except Exception:
                pass
            try:
                _node.par.file = _p["tox_path"]
            except Exception as _e:
                report["warnings"].append("engineCOMP.par.file failed: " + str(_e))
            _pm = _p["perform_mode"]
            if _pm in ("on", "off"):
                if hasattr(_node.par, "performmode"):
                    try:
                        _node.par.performmode = _pm
                    except Exception as _e:
                        report["warnings"].append("engineCOMP.par.performmode failed: " + str(_e))
                else:
                    report["warnings"].append("engineCOMP has no 'performmode' par (UNVERIFIED).")
            if _p.get("use_color_map"):
                if hasattr(_node.par, "usecolormap"):
                    try:
                        _node.par.usecolormap = True
                    except Exception as _e:
                        report["warnings"].append("engineCOMP.par.usecolormap failed: " + str(_e))
                else:
                    report["warnings"].append("engineCOMP has no 'usecolormap' par (UNVERIFIED).")
            if _p.get("reload"):
                if hasattr(_node.par, "reload"):
                    try:
                        _node.par.reload.pulse()
                    except Exception as _e:
                        report["warnings"].append("engineCOMP.par.reload.pulse() failed: " + str(_e))
                else:
                    report["warnings"].append("engineCOMP has no 'reload' par (UNVERIFIED).")
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildEngineCompScript(payload: object): string {
  return buildPayloadScript(ENGINE_COMP_SCRIPT, payload);
}

// ---------------------------------------------------------------------------
// Impl
// ---------------------------------------------------------------------------

export async function createEngineCompImpl(
  ctx: ToolContext,
  args: CreateEngineCompArgs,
): Promise<import("@modelcontextprotocol/sdk/types.js").CallToolResult> {
  return guardTd(
    async () => {
      const script = buildEngineCompScript({
        parent_path: args.parent_path,
        name: args.name,
        tox_path: args.tox_path,
        reload: args.reload,
        use_color_map: args.use_color_map,
        perform_mode: args.perform_mode,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<EngineCompReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`Engine COMP build failed: ${report.fatal}`, report);
      }
      const warnNote = report.warnings.length > 0 ? `, ${report.warnings.length} warning(s)` : "";
      const summary = `Created Engine COMP at ${report.path} loading .tox '${report.tox_path}'${warnNote}.`;
      return jsonResult(summary, report);
    },
  );
}

// ---------------------------------------------------------------------------
// Registrar
// ---------------------------------------------------------------------------

export const registerCreateEngineComp: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_engine_comp",
    {
      title: "Create Engine COMP",
      description:
        "Drop a TouchDesigner Engine COMP that loads an external .tox in a separate TD subprocess — " +
        "an independent crash domain with its own cook + (optionally) a second GPU thread, ideal for " +
        "hosting heavy or unstable subgraphs. Sets the .tox file, optional reload pulse (re-pulls the " +
        ".tox once), perform-mode override, and color-map toggle. The .tox's own outTOP/outCHOP/outSOP/" +
        "outDAT operators surface as connectors on the Engine COMP for downstream wiring. Complements " +
        "make_portable_tox (which produces the shippable .tox). Note: sub-process spin-up forks a TD " +
        "process — the first cook can be multi-second on slow disks; that is not a hang. par.reload / " +
        "par.usecolormap / par.performmode are guarded with hasattr so unverified par names degrade to " +
        "warnings rather than throwing.",
      inputSchema: createEngineCompSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createEngineCompImpl(ctx, args),
  );
};
