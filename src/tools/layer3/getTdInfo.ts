import { friendlyTdError } from "../../td-client/types.js";
import { jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const DESCRIPTION =
  "Read-only health check + TouchDesigner server info. Returns {connected, endpoint, touchdesigner version info, knowledge-base stats} and changes nothing. Use this first to confirm the bridge is reachable; it succeeds even when TD is offline, reporting connected:false with the reason.";

export async function getTdInfoImpl(ctx: ToolContext) {
  const knowledge = ctx.knowledge.stats();
  try {
    const info = await ctx.client.getInfo();
    return jsonResult("TouchDesigner is connected.", {
      connected: true,
      endpoint: ctx.client.endpoint,
      touchdesigner: info,
      knowledge,
    });
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
