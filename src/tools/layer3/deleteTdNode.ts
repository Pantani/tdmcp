import { z } from "zod";
import { guardTd, jsonStructuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const deleteTdNodeSchema = z.object({
  path: z.string().describe("Full path of the node to delete, e.g. '/project1/noise1'."),
  mode: z
    .enum(["delete", "bypass"])
    .default("delete")
    .describe(
      "'delete' (default) destroys the node; 'bypass' is the safer, reversible middle ground — it turns the operator's bypass flag on instead of removing it, so the artist can re-enable it with one click.",
    ),
  confirmation_timeout_ms: z.coerce
    .number()
    .int()
    .min(5000)
    .max(120000)
    .default(30000)
    .describe("Bounded wait for the TD-native Delete / Bypass / Keep decision."),
});
type DeleteTdNodeArgs = {
  path: string;
  mode?: "delete" | "bypass";
  confirmation_timeout_ms?: number;
};

export async function deleteTdNodeImpl(ctx: ToolContext, args: DeleteTdNodeArgs) {
  return guardTd(
    () =>
      ctx.client.deleteNode(args.path, args.mode ?? "delete", {
        confirmationPolicy: ctx.yolo ? "yolo" : "native",
        timeoutMs: args.confirmation_timeout_ms ?? 30000,
      }),
    (result) => {
      const yoloNote =
        result.confirmation_policy === "yolo"
          ? " (explicit TDMCP_YOLO policy; native confirmation skipped)"
          : "";
      if (!result.applied || result.action_applied === "keep") {
        return jsonStructuredResult(
          `Kept ${result.final_path ?? args.path} unchanged${yoloNote}.`,
          result,
        );
      }
      if (result.bypassed) {
        return jsonStructuredResult(
          `Bypassed ${result.bypassed} (not destroyed)${yoloNote}.`,
          result,
        );
      }
      return jsonStructuredResult(`Deleted ${result.deleted ?? args.path}${yoloNote}.`, result);
    },
  );
}

export const registerDeleteTdNode: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "delete_td_node",
    {
      title: "Delete TouchDesigner node",
      description:
        "Safely remove or bypass one TouchDesigner node. mode:'delete' asks the artist in TouchDesigner to choose exactly Delete / Bypass / Keep; close, timeout, error or unavailable UI means Keep. mode:'bypass' is immediate and reversible. TDMCP_YOLO is an explicit audited skip policy, never inferred from missing UI. The bridge wraps the final mutation in a TouchDesigner undo block; whole-tool undo across multiple REST requests remains unverified. Returns the decision, action applied, final path, confirmation policy/request id and undo label when available.",
      inputSchema: deleteTdNodeSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    (args) => deleteTdNodeImpl(ctx, args),
  );
};
