import { z } from "zod";
import { isMissingEndpoint } from "../../td-client/types.js";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { computeDatTextReplace } from "./datTextReplace.js";

export const editDatContentSchema = z.object({
  dat_path: z
    .string()
    .describe("Absolute path to the Text or Table DAT to edit (e.g. '/project1/mytext1')."),
  old_string: z
    .string()
    .min(1)
    .describe("Exact substring to find. Must match at least once. Empty strings are rejected."),
  new_string: z
    .string()
    .describe("Replacement text. May be empty to delete the matched substring."),
  replace_all: z
    .boolean()
    .default(false)
    .describe(
      "When false (default), requires exactly one match — 0 or >1 occurrences is an error. " +
        "Set true to replace every occurrence.",
    ),
});
type EditDatContentArgs = z.infer<typeof editDatContentSchema>;

interface EditDatReport {
  dat: string;
  occurrences: number;
  replacements: number;
  replace_all: boolean;
  warnings: string[];
  fatal?: string;
}

// One Python pass: resolve the DAT, count occurrences, validate uniqueness (unless
// replace_all), then write _d.text back. The payload is base64 so old_string /
// new_string with quotes or newlines cannot break Python quoting.
const EDIT_DAT_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"dat": _p["dat"], "occurrences": 0, "replacements": 0, "replace_all": _p["replace_all"], "warnings": []}
try:
    _d = op(_p["dat"])
    if _d is None:
        report["fatal"] = "DAT not found: " + str(_p["dat"])
    elif not _d.isDAT:
        report["fatal"] = str(_p["dat"]) + " is not a DAT."
    else:
        _old = _p["old"]
        _new = _p["new"]
        _text = _d.text
        _n = _text.count(_old)
        report["occurrences"] = _n
        if _n == 0:
            report["fatal"] = "old_string not found in " + str(_p["dat"]) + "."
        elif _n > 1 and not _p["replace_all"]:
            report["fatal"] = "old_string matches " + str(_n) + " times in " + str(_p["dat"]) + "; pass replace_all:true to replace all, or add surrounding context for a unique match."
        else:
            if _p["replace_all"]:
                _result = _text.replace(_old, _new)
                report["replacements"] = _n
            else:
                _result = _text.replace(_old, _new, 1)
                report["replacements"] = 1
            _d.text = _result
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildEditDatContentScript(payload: object): string {
  return buildPayloadScript(EDIT_DAT_SCRIPT, payload);
}

export async function editDatContentImpl(ctx: ToolContext, args: EditDatContentArgs) {
  return guardTd(
    async () => {
      // 1) first-class endpoint path (survives ALLOW_EXEC=0): read the DAT text,
      //    run the exhaustively-tested pure replace, write it back. A compute error
      //    (0 matches / >1 without replace_all / not-a-DAT) becomes report.fatal so
      //    the shared onOk turns it into an errorResult and NO write happens.
      try {
        const cur = await ctx.client.getDatText(args.dat_path);
        const res = computeDatTextReplace(
          cur.text,
          args.old_string,
          args.new_string,
          args.replace_all,
        );
        if (res.error || res.text === undefined) {
          return {
            dat: args.dat_path,
            occurrences: res.occurrences,
            replacements: res.replacements,
            replace_all: args.replace_all,
            warnings: [],
            fatal: res.error ?? "edit_dat_content: nothing to replace.",
          } as EditDatReport;
        }
        await ctx.client.putDatText(args.dat_path, res.text);
        return {
          dat: args.dat_path,
          occurrences: res.occurrences,
          replacements: res.replacements,
          replace_all: args.replace_all,
          warnings: [],
        } as EditDatReport;
      } catch (err) {
        // Fall back ONLY when the endpoint is absent (older bridge); a current
        // bridge's validation 400 (invalid DAT path, etc.) must surface instead
        // of silently running the exec path.
        if (!isMissingEndpoint(err)) throw err;
      }
      const script = buildEditDatContentScript({
        dat: args.dat_path,
        old: args.old_string,
        new: args.new_string,
        replace_all: args.replace_all,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<EditDatReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(report.fatal, report);
      }
      const summary = `Replaced ${report.replacements} occurrence(s) in ${report.dat} (${report.occurrences} match(es) found).`;
      return jsonResult(summary, report);
    },
  );
}

export const registerEditDatContent: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "edit_dat_content",
    {
      title: "Edit DAT content (surgical)",
      description:
        "Surgically replace a substring inside a Text or Table DAT's `.text`. " +
        "Without `replace_all`, requires exactly one match — 0 or >1 occurrences is an error, " +
        "forcing the caller to add context or set `replace_all`. " +
        "Use `set_dat_content` to overwrite an entire DAT's text in place; use this to make a targeted edit.",
      inputSchema: editDatContentSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    (args) => editDatContentImpl(ctx, args),
  );
};
