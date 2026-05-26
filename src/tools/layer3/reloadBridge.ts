import { z } from "zod";
import { parsePythonReport } from "../pythonReport.js";
import { guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

// Takes no arguments; the empty object keeps the CLI/schema plumbing uniform.
export const reloadBridgeSchema = z.object({});

interface ReloadReport {
  reloaded: string[];
  count: number;
}

// Editing files under td/ does NOT reload the modules a running TouchDesigner
// already imported, so the bridge keeps serving stale code until reopened. This
// reimports every loaded mcp.*/utils.* module in place (deepest-first), so the
// next request runs the edited code without reopening the project.
const RELOAD_SCRIPT = `
import json
from mcp import dev
_reloaded = dev.reload_bridge()
print(json.dumps({"reloaded": _reloaded, "count": len(_reloaded)}))
`;

export async function reloadBridgeImpl(ctx: ToolContext) {
  return guardTd(
    async () => {
      const exec = await ctx.client.executePythonScript(RELOAD_SCRIPT, true);
      return parsePythonReport<ReloadReport>(exec.stdout);
    },
    (report) =>
      jsonResult(
        `Reloaded ${report.count} bridge module(s) in place — edits under td/ are now live.`,
        report,
      ),
  );
}

export const registerReloadBridge: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "reload_bridge",
    {
      title: "Reload bridge",
      description:
        "Hot-reload the bridge's Python inside the running TouchDesigner, so edits to the td/ modules take effect without reopening the project. Reimports every loaded mcp.*/utils.* module in place and returns the list reloaded. Use after editing bridge code.",
      inputSchema: reloadBridgeSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    () => reloadBridgeImpl(ctx),
  );
};
