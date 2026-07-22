import { z } from "zod";
import { errorResult, guardTd, jsonStructuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const focusNetworkEditorSchema = z.object({
  paths: z
    .array(
      z
        .string()
        .trim()
        .min(1)
        .max(1024)
        .refine((path) => path.startsWith("/"), "Operator paths must be absolute."),
    )
    .min(1)
    .max(64)
    .describe("Operator paths to frame in the Network Editor, e.g. the nodes you just created."),
  animate: z
    .boolean()
    .default(true)
    .describe(
      "Request bounded next-frame follow. On the live-proven build, framing uses six generation-checked ease-out viewport steps and reports stepped or instant readback.",
    ),
  action: z
    .enum(["create", "edit", "inspect", "view", "layout", "delete"])
    .default("view")
    .describe("Action category used to make the follow receipt understandable and auditable."),
  framing: z
    .enum(["auto", "selection", "owner", "none"])
    .default("auto")
    .describe(
      "How to frame the result: auto avoids surprise zoom-in, selection fits targets, owner homes the network, and none changes only current/selection.",
    ),
  enabled: z
    .boolean()
    .default(true)
    .describe(
      "Explicit opt-out. Disabled follow returns a typed suppression without moving the UI.",
    ),
});
type FocusNetworkEditorArgs = z.input<typeof focusNetworkEditorSchema>;

type FocusReceipt = {
  focused: string[];
  pane?: string | null;
  animate: boolean;
  operation_id?: string;
  status?: "scheduled" | "applied" | "suppressed" | "cancelled" | "failed" | "expired";
  suppression_reason?: string | null;
  warnings?: string[];
  [key: string]: unknown;
};

type FocusOptions = {
  action: "create" | "edit" | "inspect" | "view" | "layout" | "delete";
  framing: "auto" | "selection" | "owner" | "none";
  enabled: boolean;
};

function focusSummary(result: FocusReceipt) {
  if (!result.status || result.status === "applied") {
    return `Framed ${result.focused.length} operator(s) in the Network Editor${
      result.pane ? ` (${result.pane})` : ""
    }.`;
  }
  if (result.status === "scheduled") {
    return "Scheduled a bounded Network Editor follow; final UI readback is still pending.";
  }
  if (result.status === "suppressed") {
    return `Network Editor follow was safely suppressed (${result.suppression_reason ?? "unavailable"}).`;
  }
  return `Network Editor follow ended as ${result.status}; no successful framing is claimed.`;
}

export async function focusNetworkEditorImpl(ctx: ToolContext, args: FocusNetworkEditorArgs) {
  const animate = args.animate ?? true;
  const options: FocusOptions = {
    action: args.action ?? "view",
    framing: args.framing ?? "auto",
    enabled: args.enabled ?? true,
  };
  const focusEditor = ctx.client.focusEditor as unknown as (
    paths: string[],
    animate: boolean,
    options: FocusOptions,
  ) => Promise<FocusReceipt>;
  return guardTd(
    () => focusEditor.call(ctx.client, args.paths, animate, options),
    (result) => {
      const summary = focusSummary(result);
      if (result.status === "failed" || result.status === "expired") {
        return errorResult(summary, result);
      }
      return jsonStructuredResult(summary, result);
    },
  );
}

export const registerFocusNetworkEditor: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "focus_network_editor",
    {
      title: "Focus the Network Editor",
      description:
        "Safely follow one same-parent operator group in an existing TouchDesigner Network Editor. Reuses the active/already-owning pane, replaces stale selection, sets an explicit current operator, and returns applied or fail-closed suppression readback. UI-only: it never creates panes or changes project topology, and Perform/headless/disabled states do not steal focus. Smooth colour highlights remain held pending live compare-and-swap proof.",
      inputSchema: focusNetworkEditorSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => focusNetworkEditorImpl(ctx, args),
  );
};
