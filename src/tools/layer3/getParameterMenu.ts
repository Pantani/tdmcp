import { z } from "zod";
import { TdApiError } from "../../td-client/types.js";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const getParameterMenuSchema = z.object({
  path: z.string().describe("Full path of the node whose parameter menus to read."),
  keys: z
    .array(z.string())
    .optional()
    .describe("Only report these parameter names (case-sensitive). Omit for all menu parameters."),
  menu_only: z
    .boolean()
    .default(true)
    .describe(
      "Only return parameters that actually have a menu (Menu / StrMenu). Set false to see every parameter with its (usually empty) menu.",
    ),
});
type GetParameterMenuArgs = z.infer<typeof getParameterMenuSchema>;

export const parameterMenuInfoSchema = z.object({
  name: z.string(),
  label: z.string().optional(),
  style: z.string().optional(),
  current: z.string().optional(),
  menuNames: z.array(z.string()),
  menuLabels: z.array(z.string()),
});

export const getParameterMenuOutputSchema = z.object({
  path: z.string(),
  type: z.string(),
  name: z.string(),
  parameters: z.array(parameterMenuInfoSchema),
  stale_catalog_warning: z.string().optional(),
  warnings: z.array(z.string()),
});

interface MenuEntry {
  name: string;
  label?: string;
  style?: string;
  current?: string;
  menuNames: string[];
  menuLabels: string[];
}

interface GetParameterMenuReport {
  path: string;
  type: string;
  name: string;
  parameters: MenuEntry[];
  warnings: string[];
  fatal?: string;
}

// The payload travels as base64 so arbitrary strings cannot break Python quoting.
// All TD globals (op, etc.) live inside this script string — never outside it.
// menuNames / menuLabels are read via getattr because non-menu pars (and thin
// bindings) may not expose them; a fresh/paused node returns [] for dynamic menus.
const GET_PARAMETER_MENU_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"path": _p["path"], "type": "", "name": "", "parameters": [], "warnings": []}
try:
    _c = op(_p["path"])
    if _c is None:
        report["fatal"] = "Node not found: " + str(_p["path"])
    else:
        report["type"] = _c.type
        report["name"] = _c.name
        _keys_raw = _p.get("keys")
        _keys = None if _keys_raw is None else _keys_raw
        _menu_only = bool(_p.get("menu_only", True))
        for par in _c.pars():
            try:
                _pname = par.name
                if _keys is not None and _pname not in _keys:
                    continue
                _names = list(getattr(par, "menuNames", []) or [])
                _labels = list(getattr(par, "menuLabels", []) or [])
                if _menu_only and not _names:
                    continue
                _entry = {
                    "name": _pname,
                    "label": getattr(par, "label", None),
                    "style": getattr(par, "style", None),
                    "menuNames": [str(x) for x in _names],
                    "menuLabels": [str(x) for x in _labels],
                }
                try:
                    _entry["current"] = str(par.eval())
                except Exception:
                    pass
                report["parameters"].append(_entry)
            except Exception:
                try:
                    report["warnings"].append(
                        "Error reading par " + str(par.name) + ": " + traceback.format_exc().splitlines()[-1]
                    )
                except Exception:
                    report["warnings"].append(
                        "Error reading unknown par: " + traceback.format_exc().splitlines()[-1]
                    )
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildGetParameterMenuScript(payload: object): string {
  return buildPayloadScript(GET_PARAMETER_MENU_SCRIPT, payload);
}

const STALE_WARNING =
  "Menu values from the bundled catalog (may be stale for this TD build); run with TouchDesigner reachable for authoritative menus.";

/**
 * True when the exec path is unavailable because raw Python exec is disabled on
 * the bridge (as opposed to a real node/script error we should surface). The
 * bridge answers a disabled `/api/exec` with HTTP 403 (`_Forbidden`); a real
 * script/node failure comes back as an HTTP 400 or as an in-band traceback in
 * stdout, so matching on the structured 403 status avoids misclassifying a
 * genuine failure and silently falling back to the stale catalog.
 */
function isExecUnavailable(err: unknown): boolean {
  return err instanceof TdApiError && err.status === 403;
}

/**
 * Loud-warned fallback: the bundled KB carries `menuItems`, but the imported data
 * is known-degenerate, so this is only consulted when the authoritative exec path
 * is unavailable — and it always attaches `stale_catalog_warning`.
 */
async function staleCatalogFallback(
  ctx: ToolContext,
  args: GetParameterMenuArgs,
): Promise<GetParameterMenuReport & { stale_catalog_warning: string }> {
  const node = await ctx.client.getNode(args.path);
  const operator = ctx.knowledge.getOperator(node.type);
  const keys = args.keys;
  const parameters: MenuEntry[] = [];
  for (const p of operator?.parameters ?? []) {
    if (keys && !keys.includes(p.name)) continue;
    const menuNames = p.menuItems ?? [];
    if (args.menu_only && menuNames.length === 0) continue;
    parameters.push({
      name: p.name,
      label: p.label,
      menuNames: menuNames.map((x) => String(x)),
      menuLabels: (p.menuLabels ?? []).map((x) => String(x)),
    });
  }
  return {
    path: node.path,
    type: node.type,
    name: node.name,
    parameters,
    warnings: [STALE_WARNING],
    stale_catalog_warning: STALE_WARNING,
  };
}

export async function getParameterMenuImpl(ctx: ToolContext, args: GetParameterMenuArgs) {
  return guardTd(
    async () => {
      const script = buildGetParameterMenuScript({
        path: args.path,
        keys: args.keys ?? null,
        menu_only: args.menu_only,
      });
      try {
        const exec = await ctx.client.executePythonScript(script, true);
        return parsePythonReport<GetParameterMenuReport>(exec.stdout);
      } catch (err) {
        // Only fall back to the bundled (degenerate) catalog when raw exec is
        // unavailable; any real node/script error is rethrown so guardTd surfaces it.
        if (!isExecUnavailable(err)) throw err;
        return staleCatalogFallback(ctx, args);
      }
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`get_parameter_menu failed: ${report.fatal}`, report);
      }
      const stale = (report as GetParameterMenuReport & { stale_catalog_warning?: string })
        .stale_catalog_warning;
      const suffix = stale ? " (bundled catalog — may be stale)" : "";
      const summary = `${report.parameters.length} menu parameter(s) for ${report.path} (${report.type})${suffix}.`;
      return structuredResult(summary, {
        path: report.path,
        type: report.type,
        name: report.name,
        parameters: report.parameters,
        ...(stale ? { stale_catalog_warning: stale } : {}),
        warnings: report.warnings,
      });
    },
  );
}

export const registerGetParameterMenu: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "get_parameter_menu",
    {
      title: "Get parameter menu values",
      description:
        "Read-only: for each menu parameter of a node, live-fetch the menu option values (`menuNames` — the machine values you set with `par.val`), their human-readable UI labels (`menuLabels`), and the currently selected value (`current`). Use this before setting a Menu / StrMenu parameter so you pick a valid option instead of guessing. Values come straight from the running TouchDesigner build, so they are authoritative and even include dynamically-populated menus (device lists, file menus) — an empty `menuNames` on a known-menu parameter means the menu has not populated yet (the node has not cooked / the device is not enumerated), not that there is no menu. Requires TDMCP_BRIDGE_ALLOW_EXEC=1; when raw exec is unavailable it falls back to the bundled catalog and attaches a stale-catalog warning.",
      inputSchema: getParameterMenuSchema.shape,
      outputSchema: getParameterMenuOutputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    (args) => getParameterMenuImpl(ctx, args),
  );
};
