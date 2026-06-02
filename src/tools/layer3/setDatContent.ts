import { z } from "zod";
import { tryEndpoint } from "../../td-client/types.js";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const setDatContentSchema = z.object({
  dat_path: z
    .string()
    .describe(
      "Absolute path to the Text or Table DAT whose content will be fully replaced " +
        "(e.g. '/project1/mytext1').",
    ),
  text: z
    .string()
    .describe(
      "The full new contents of the DAT. Every existing character will be discarded; " +
        "this string becomes the entire `.text` value.",
    ),
  confirm_wipe: z
    .boolean()
    .default(false)
    .describe(
      "Set true to allow writing empty or whitespace-only text, which clears the DAT. " +
        "When false (default), the tool refuses to write blank content to prevent silent data loss.",
    ),
});
type SetDatContentArgs = z.infer<typeof setDatContentSchema>;

interface SetDatReport {
  dat: string;
  old_length: number;
  new_length: number;
  wiped: boolean;
  warnings: string[];
  fatal?: string;
}

// One Python pass: resolve the DAT, snapshot old_length, overwrite .text, report new_length.
// The payload travels as base64 so arbitrary text (quotes, newlines, unicode) cannot
// break Python quoting. wiped=True signals the caller that the DAT was intentionally cleared.
const SET_DAT_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"dat": _p["dat"], "old_length": 0, "new_length": 0, "wiped": False, "warnings": []}
try:
    _d = op(_p["dat"])
    if _d is None:
        report["fatal"] = "DAT not found: " + str(_p["dat"])
    elif not _d.isDAT:
        report["fatal"] = str(_p["dat"]) + " is not a DAT."
    else:
        report["old_length"] = len(_d.text)
        _d.text = _p["text"]
        report["new_length"] = len(_p["text"])
        report["wiped"] = (_p["text"].strip() == "")
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildSetDatContentScript(payload: object): string {
  return buildPayloadScript(SET_DAT_SCRIPT, payload);
}

export async function setDatContentImpl(ctx: ToolContext, args: SetDatContentArgs) {
  // Anti-wipe guardrail: refuse to silently clear a DAT unless the caller
  // acknowledges they mean to do so. This mirrors the manageComponentImpl
  // pre-flight pattern — checked in TS before any bridge call so the test
  // can assert it without touching the network.
  if (args.text.trim() === "" && !args.confirm_wipe) {
    return errorResult(
      `Refusing to clear ${args.dat_path}: the new text is empty. ` +
        "Pass confirm_wipe:true to wipe it on purpose.",
    );
  }
  return guardTd(
    async () => {
      // 1) first-class endpoint (survives ALLOW_EXEC=0): PUT the whole text. The
      //    endpoint returns old_length/new_length, so no extra read round-trip.
      // 2) Fall back to exec ONLY when the endpoint is absent on an older bridge;
      //    a current bridge's validation 400 (not-a-DAT, node not found) surfaces
      //    unchanged via tryEndpoint.
      return tryEndpoint<SetDatReport>(
        async () => {
          const w = await ctx.client.putDatText(args.dat_path, args.text);
          return {
            dat: args.dat_path,
            old_length: w.old_length,
            new_length: w.new_length,
            wiped: args.text.trim() === "",
            warnings: [],
          };
        },
        async () => {
          const script = buildSetDatContentScript({ dat: args.dat_path, text: args.text });
          const exec = await ctx.client.executePythonScript(script, true);
          return parsePythonReport<SetDatReport>(exec.stdout);
        },
      );
    },
    (report) => {
      if (report.fatal) {
        return errorResult(report.fatal, report);
      }
      const wipedSuffix = report.wiped ? ", wiped" : "";
      const summary = `Wrote ${report.new_length} char(s) to ${report.dat} (was ${report.old_length})${wipedSuffix}.`;
      return jsonResult(summary, report);
    },
  );
}

export const registerSetDatContent: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "set_dat_content",
    {
      title: "Set DAT content (whole)",
      description:
        "Overwrite a Text or Table DAT's entire `.text` with new content. " +
        "Unlike `edit_dat_content` (which makes a surgical find-and-replace), this replaces " +
        "everything in one shot — use it to deploy a full script or template. " +
        "Refuses to write empty/whitespace-only text unless `confirm_wipe:true` is passed, " +
        "preventing silent data loss.",
      inputSchema: setDatContentSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    (args) => setDatContentImpl(ctx, args),
  );
};
