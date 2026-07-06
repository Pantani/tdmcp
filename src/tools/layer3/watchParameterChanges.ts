import { z } from "zod";
import { errorResult, guardTd, structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const watchParameterChangesSchema = z.object({
  path: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Operator path to watch for parameter changes, e.g. /project1/level1. Required for action='watch'/'unwatch'; omit for action='list'.",
    ),
  parameters: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "Optional list of parameter names to watch (e.g. ['opacity','level']). Omit to watch every parameter on the operator.",
    ),
  action: z
    .enum(["watch", "unwatch", "list"])
    .default("watch")
    .describe(
      "'watch' registers a subscription, 'unwatch' removes it (or just the named parameters), 'list' returns all active watches.",
    ),
});
type WatchParameterChangesArgs = z.infer<typeof watchParameterChangesSchema>;

export const watchParameterChangesOutputSchema = z.object({
  action: z.string().describe("The action that was performed: watch, unwatch, or list."),
  path: z.string().optional().describe("The canonical operator path (for watch/unwatch)."),
  parameters: z
    .array(z.string())
    .nullable()
    .optional()
    .describe("Parameters now watched on this op, or null for a watch-all subscription."),
  watching: z
    .boolean()
    .optional()
    .describe("Whether an active watch remains on this op after the action."),
  watches: z
    .array(z.object({ path: z.string(), parameters: z.array(z.string()).nullable() }))
    .optional()
    .describe("Every active watch (for the 'list' action)."),
  count: z.number().optional().describe("Number of active watches (for the 'list' action)."),
});

export async function watchParameterChangesImpl(ctx: ToolContext, args: WatchParameterChangesArgs) {
  if (args.action === "list") {
    return guardTd(
      () => ctx.client.listParameterWatches(),
      (result) =>
        structuredResult(`${result.count} active parameter watch(es).`, {
          action: "list",
          watches: result.watches.map((w) => ({ path: w.path, parameters: w.pars })),
          count: result.count,
        }),
    );
  }

  // watch/unwatch operate on a specific op, so `path` is required for them.
  if (!args.path?.trim()) {
    return errorResult(
      `watch_parameter_changes action='${args.action}' requires a non-empty \`path\`.`,
    ) as ReturnType<typeof structuredResult>;
  }
  const path = args.path;

  if (args.action === "unwatch") {
    return guardTd(
      () => ctx.client.unwatchParameters(path, { pars: args.parameters }),
      (result) =>
        structuredResult(
          result.watching
            ? `Updated watch on ${result.path}; still watching ${describePars(result.pars)}.`
            : `Removed the parameter watch on ${result.path}.`,
          {
            action: "unwatch",
            path: result.path,
            parameters: result.pars,
            watching: result.watching,
          },
        ),
    );
  }

  return guardTd(
    () => ctx.client.watchParameters(path, { pars: args.parameters }),
    (result) =>
      structuredResult(
        `Watching ${describePars(result.pars)} on ${result.path}. Changes surface as ` +
          "`param.changed` MCP logging notifications (enable the TD event stream with " +
          "TDMCP_EVENTS to receive them; it is a high-frequency event, coalesced bridge-side).",
        {
          action: "watch",
          path: result.path,
          parameters: result.pars,
          watching: result.watching,
        },
      ),
  );
}

function describePars(pars: string[] | null): string {
  if (pars === null || pars.length === 0) return "all parameters";
  return `parameter(s) ${pars.join(", ")}`;
}

export const registerWatchParameterChanges: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "watch_parameter_changes",
    {
      title: "Watch operator parameter changes",
      description:
        "Opt-in: subscribe to `param.changed` events for an operator's parameters. When a watched parameter's value changes in TouchDesigner (by a human or a script), the bridge broadcasts a {path, par, prev, value, frame} event on the TD event stream, forwarded to the MCP client as a logging notification. Use action='watch' to register (optionally scoped to named `parameters`), 'unwatch' to remove, and 'list' to see active watches. Events only arrive when the server's TD event stream is enabled (TDMCP_EVENTS); param.changed is treated as a high-frequency event (coalesced bridge-side so a slider drag can't flood). Survives TDMCP_BRIDGE_ALLOW_EXEC=0.",
      inputSchema: watchParameterChangesSchema.shape,
      outputSchema: watchParameterChangesOutputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => watchParameterChangesImpl(ctx, args),
  );
};
