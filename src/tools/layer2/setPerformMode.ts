import { z } from "zod";
import { tryEndpoint } from "../../td-client/types.js";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const setPerformModeSchema = z.object({
  enabled: z
    .boolean()
    .describe(
      "true to enter perform mode before a live show, false to leave it afterward. " +
        "While perform mode is ON, tools that honor the advisory flag skip nonessential compute. " +
        "The built-in guard currently suppresses auto preview captures; future tools can opt in " +
        "by checking " +
        "op('/').fetch('tdmcp_perform_mode', False) before doing expensive work. " +
        "It does NOT stop the TD timeline or kill audio/video processing.",
    ),
});
type SetPerformModeArgs = z.infer<typeof setPerformModeSchema>;

interface PerformModeReport {
  enabled: boolean;
  stored: boolean;
  was: boolean;
  /** True when this build exposed `ui.performMode` and it was set (success, not a warning). */
  ui_perform_mode_set: boolean;
  /** True when this build exposed a writable `project.performMode`. Endpoint-only; the
   *  exec-fallback path always reports `false`. */
  project_perform_mode_set?: boolean;
  warnings: string[];
  fatal?: string;
  /** Internal: which transport served the report. Lets the unit test prove fallback fired. */
  _source?: "endpoint" | "exec";
}

// The flag is stored on the TD root op via op('/').store() so it persists for
// the lifetime of the session and can be read cheaply from any context.
// We do NOT add a REST bridge endpoint — this is a single Python pass via
// executePythonScript, following the established escape-hatch pattern.
//
// Optionally we probe project.cookRate / ui.performMode / app.performMode for
// a documented "realtime / perform" knob on this TD build. If none is found
// we record a note in warnings rather than silently failing or guessing at a
// non-existent attribute — the stored flag is the primary contract.
const PERFORM_MODE_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"enabled": bool(_p["enabled"]), "stored": False, "was": False, "ui_perform_mode_set": False, "warnings": []}
try:
    _root = op('/')
    report["was"] = bool(_root.fetch('tdmcp_perform_mode', False))
    _root.store('tdmcp_perform_mode', bool(_p["enabled"]))
    report["stored"] = bool(_root.fetch('tdmcp_perform_mode', False))
    # Opportunistically probe for a real TD perform / realtime toggle.
    # TD 2023+ exposes ui.performMode (bool); probe before setting it so we
    # never break on builds that don't have it.
    try:
        if hasattr(ui, 'performMode'):
            ui.performMode = bool(_p["enabled"])
            report["ui_perform_mode_set"] = True
        else:
            report["warnings"].append(
                "ui.performMode not found on this TD build — flag stored but no native knob adjusted."
            )
    except Exception as _e:
        report["warnings"].append("Could not set ui.performMode: " + str(_e))
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildSetPerformModeScript(payload: object): string {
  return buildPayloadScript(PERFORM_MODE_SCRIPT, payload);
}

export async function setPerformModeImpl(ctx: ToolContext, args: SetPerformModeArgs) {
  return guardTd(
    async () =>
      tryEndpoint<PerformModeReport>(
        async () => {
          const state = await ctx.client.setPerformMode(args.enabled);
          return { ...state, _source: "endpoint" };
        },
        async () => {
          const script = buildSetPerformModeScript({ enabled: args.enabled });
          const exec = await ctx.client.executePythonScript(script, true);
          const report = parsePythonReport<PerformModeReport>(exec.stdout);
          return { ...report, _source: "exec" };
        },
      ),
    (report) => {
      if (report.fatal) {
        return errorResult(`set_perform_mode failed: ${report.fatal}`, report);
      }
      const onOff = (v: boolean) => (v ? "ON" : "OFF");
      const action = report.enabled ? "skip" : "resume";
      const summary =
        `Perform mode ${onOff(report.enabled)} (was ${onOff(report.was)}). ` +
        `Tools that honor the advisory flag will ${action} nonessential compute; ` +
        "the built-in guard currently covers preview captures.";
      return jsonResult(summary, report);
    },
  );
}

export const registerSetPerformMode: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "set_perform_mode",
    {
      title: "Set perform mode",
      description:
        "Toggle perform mode — the one switch the artist flips before going live. " +
        "When enabled, tdmcp stores an advisory flag that tools can read before doing " +
        "nonessential compute; the built-in guard currently suppresses auto preview captures. " +
        "The flag is stored on the TD root op (op('/').store('tdmcp_perform_mode', ...)). " +
        "Advisory: this does not stop the TD timeline or kill audio/video processing. " +
        "Call with enabled=false after the show to resume normal operation.",
      inputSchema: setPerformModeSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => setPerformModeImpl(ctx, args),
  );
};
