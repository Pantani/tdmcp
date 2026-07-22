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
  overwrite_policy: z
    .enum(["refuse", "ask"])
    .default("refuse")
    .describe(
      "(save) Refuse an existing target, or ask through the native TouchDesigner broker before overwrite.",
    ),
  confirmation_timeout_ms: z
    .number()
    .int()
    .min(5_000)
    .max(120_000)
    .default(30_000)
    .describe("(save) Bounded wait for native overwrite consent."),
  operation_timeout_ms: z
    .number()
    .int()
    .min(1_000)
    .max(120_000)
    .default(60_000)
    .describe("(save) Bounded polling deadline for the deferred export job."),
  idempotency_key: z
    .string()
    .min(16)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional()
    .describe("(save) Opaque retry key for response-loss recovery."),
});
type ManageComponentArgs = z.input<typeof manageComponentSchema>;

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

// Load remains the legacy path in this wave. Save is deliberately absent here:
// every export goes through the structured, broker-aware transaction above.
const COMPONENT_SCRIPT = `
import json, base64, traceback, os
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"action": _p["action"], "file_path": _p["file_path"], "warnings": []}
try:
    _action = _p["action"]; _fp = _p["file_path"]
    if _action == "load":
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
        report["fatal"] = "Unsupported legacy component action: " + str(_action)
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildComponentScript(payload: object): string {
  return buildPayloadScript(COMPONENT_SCRIPT, payload);
}

export async function manageComponentImpl(ctx: ToolContext, rawArgs: ManageComponentArgs) {
  const args = manageComponentSchema.parse(rawArgs);
  if (args.action === "save" && !args.comp_path) {
    return errorResult("A `comp_path` is required to save a component.");
  }
  if (args.action === "save") {
    return guardTd(
      () =>
        ctx.client.exportToxTransaction({
          source_path: args.comp_path as string,
          target_path: args.file_path,
          mode: "as_is",
          create_folders: args.create_folders,
          overwrite_policy: args.overwrite_policy,
          confirmation_timeout_ms: args.confirmation_timeout_ms,
          operation_timeout_ms: args.operation_timeout_ms,
          idempotency_key: args.idempotency_key,
        }),
      (report) => {
        if (report.status === "succeeded" && report.artifact) {
          return jsonResult(
            `Saved ${args.comp_path} to ${report.artifact.path} (${report.artifact.size_bytes} bytes).`,
            report,
          );
        }
        if (report.status === "cancelled" && report.decision === "Keep") {
          return jsonResult(
            `Kept the existing file at ${args.file_path}; no export was applied.`,
            report,
          );
        }
        return errorResult(
          `Component save did not complete: ${report.error?.message ?? report.status}.`,
          report,
        );
      },
    );
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
        "Build a reusable component library by moving COMPs to/from .tox files on disk. 'save' uses a deferred, verified same-directory temporary export and refuses overwrite by default; set overwrite_policy='ask' for native Overwrite/Keep consent. 'load' keeps its legacy behavior and reads file_path into parent_path. Paths are on the machine running TouchDesigner.",
      inputSchema: manageComponentSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    (args) => manageComponentImpl(ctx, args),
  );
};
