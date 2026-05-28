import { z } from "zod";
import { placeInGridScript } from "../layout.js";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const manageComponentSchema = z.object({
  action: z
    .enum(["save", "load"])
    .describe("save a COMP to a .tox file, or load a .tox into the project."),
  file_path: z
    .string()
    .describe("Absolute path to the .tox file (e.g. '/Users/me/components/widget.tox')."),
  comp_path: z
    .string()
    .optional()
    .describe("(save) The COMP to save as a reusable .tox component."),
  parent_path: z
    .string()
    .default("/project1")
    .describe("(load) COMP to place the loaded component inside."),
  linked: z
    .boolean()
    .default(false)
    .describe(
      "(load) Create a live-linked instance (externaltox) that re-reads the file on change, instead of an independent copy.",
    ),
  name: z
    .string()
    .optional()
    .describe("(load, linked) Name for the linked COMP; defaults to the file name."),
  create_folders: z
    .boolean()
    .default(false)
    .describe("(save) Create the parent folders if they do not exist."),
});
type ManageComponentArgs = z.infer<typeof manageComponentSchema>;

interface ComponentReport {
  action: string;
  file_path: string;
  saved?: string;
  size?: number | null;
  loaded?: string;
  linked?: boolean;
  type?: string;
  children?: string[];
  warnings: string[];
  fatal?: string;
}

// .tox save/load is a COMP file operation with no structured bridge endpoint.
// `loadTox` drops an independent copy under the parent; `externaltox` makes a
// live-linked instance that re-reads the file. The file runs inside TouchDesigner,
// so paths are on the machine running TD.
const COMPONENT_SCRIPT = `
import json, base64, traceback, os
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"action": _p["action"], "file_path": _p["file_path"], "warnings": []}
try:
    _action = _p["action"]; _fp = _p["file_path"]
    if _action == "save":
        _c = op(_p.get("comp"))
        if _c is None:
            report["fatal"] = "COMP not found: " + str(_p.get("comp"))
        elif not _c.isCOMP:
            report["fatal"] = str(_p.get("comp")) + " is not a COMP, so it cannot be saved as a .tox."
        else:
            _saved = _c.save(_fp, createFolders=bool(_p.get("create_folders")))
            report["saved"] = str(_saved)
            report["size"] = os.path.getsize(_fp) if os.path.isfile(_fp) else None
    elif _action == "load":
        if not os.path.isfile(_fp):
            report["fatal"] = "File not found: " + _fp
        else:
            _parent = op(_p["parent"])
            if _parent is None:
                report["fatal"] = "Parent COMP not found: " + str(_p["parent"])
            elif _p.get("linked"):
                _stem = os.path.splitext(os.path.basename(_fp))[0]
                _new = _parent.create(baseCOMP, _p.get("name") or _stem)
                _new.par.externaltox = _fp
                try:
                    _new.par.reinitnet.pulse()
                except Exception:
                    pass
                report["loaded"] = _new.path; report["linked"] = True
                report["type"] = _new.type; report["children"] = sorted([c.name for c in _new.children])
            else:
                _new = _parent.loadTox(_fp)
                if _new is None:
                    report["fatal"] = "loadTox produced no component from " + _fp
                else:
                    report["loaded"] = _new.path; report["linked"] = False
                    report["type"] = _new.type; report["children"] = sorted([c.name for c in _new.children])
    else:
        report["fatal"] = "Unknown action: " + str(_action)
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildComponentScript(payload: object): string {
  return buildPayloadScript(COMPONENT_SCRIPT, payload);
}

export async function manageComponentImpl(ctx: ToolContext, args: ManageComponentArgs) {
  if (args.action === "save" && !args.comp_path) {
    return errorResult("A `comp_path` is required to save a component.");
  }
  return guardTd(
    async () => {
      const script = buildComponentScript({
        action: args.action,
        file_path: args.file_path,
        comp: args.comp_path ?? null,
        parent: args.parent_path,
        linked: args.linked,
        name: args.name ?? null,
        create_folders: args.create_folders,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      const report = parsePythonReport<ComponentReport>(exec.stdout);
      // A freshly loaded .tox lands at the origin; tile it into the grid (cosmetic).
      if (args.action === "load" && report.loaded && !report.fatal) {
        try {
          await ctx.client.executePythonScript(
            placeInGridScript(args.parent_path, report.loaded),
            false,
          );
        } catch (err) {
          ctx.logger.debug("component placement skipped", { err: String(err) });
        }
      }
      return report;
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`Component ${report.action} failed: ${report.fatal}`, report);
      }
      const summary =
        report.action === "save"
          ? `Saved ${args.comp_path} to ${report.saved}${report.size != null ? ` (${report.size} bytes)` : ""}.`
          : `Loaded ${report.loaded}${report.linked ? " (live-linked)" : ""} from ${report.file_path}${
              report.children?.length ? ` — ${report.children.length} child node(s)` : ""
            }.`;
      return jsonResult(summary, report);
    },
  );
}

export const registerManageComponent: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "manage_component",
    {
      title: "Save / load component (.tox)",
      description:
        "Build a reusable component library: save any COMP as a .tox file, or load a .tox back into the project (as an independent copy, or a live-linked instance via `linked`). Paths are on the machine running TouchDesigner.",
      inputSchema: manageComponentSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => manageComponentImpl(ctx, args),
  );
};
