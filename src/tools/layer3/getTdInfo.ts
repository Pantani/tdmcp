import { friendlyTdError } from "../../td-client/types.js";
import { jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const DESCRIPTION =
  "Read-only health check + TouchDesigner server info. Returns {connected, endpoint, touchdesigner version info, knowledge-base stats, bridge_stale?} and changes nothing. Use this first to confirm the bridge is reachable; it succeeds even when TD is offline, reporting connected:false with the reason. Also warns when the running Python bridge is older than this build (a common gotcha — editing td/ doesn't reload the running bridge), pointing you at reload_bridge.";

/**
 * The bridge version this build of tdmcp ships (td/modules/utils/version.py). Keep in
 * sync with that file + package.json on every release. Used to warn when the *running*
 * bridge is stale relative to the source (the recurring "edited td/ but it didn't take"
 * gotcha) so a confusing class of failures gets a named, actionable message.
 */
const EXPECTED_BRIDGE_VERSION = "0.6.1";

export async function getTdInfoImpl(ctx: ToolContext) {
  const knowledge = ctx.knowledge.stats();
  try {
    const info = (await ctx.client.getInfo()) as Record<string, unknown> & {
      bridge_version?: string;
    };
    const running = typeof info.bridge_version === "string" ? info.bridge_version : undefined;
    const stale =
      running !== undefined && running !== "unknown" && running !== EXPECTED_BRIDGE_VERSION;
    return jsonResult(
      stale
        ? `TouchDesigner is connected, but the running bridge is stale (running ${running}, expected ${EXPECTED_BRIDGE_VERSION}). Run reload_bridge or reopen the project.`
        : "TouchDesigner is connected.",
      {
        connected: true,
        endpoint: ctx.client.endpoint,
        touchdesigner: info,
        expected_bridge_version: EXPECTED_BRIDGE_VERSION,
        bridge_stale: stale,
        ...(stale
          ? {
              bridge_warning: `Running bridge ${running} ≠ expected ${EXPECTED_BRIDGE_VERSION}; edits under td/ won't take effect until you reload_bridge (or reopen the project).`,
            }
          : {}),
        knowledge,
      },
    );
  } catch (err) {
    return jsonResult("TouchDesigner is not reachable (the server is still running).", {
      connected: false,
      endpoint: ctx.client.endpoint,
      reason: friendlyTdError(err),
      knowledge,
    });
  }
}

export const registerGetTdInfo: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "get_td_info",
    {
      title: "Get TouchDesigner info",
      description: DESCRIPTION,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    () => getTdInfoImpl(ctx),
  );
};
