import { z } from "zod";
import { guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const focusNetworkEditorSchema = z.object({
  paths: z
    .array(z.string())
    .min(1)
    .describe("Operator paths to frame in the Network Editor, e.g. the nodes you just created."),
  animate: z
    .boolean()
    .default(true)
    .describe("Let TouchDesigner animate the pan/zoom to the operators (a 'follow' move)."),
});
type FocusNetworkEditorArgs = z.infer<typeof focusNetworkEditorSchema>;

export async function focusNetworkEditorImpl(ctx: ToolContext, args: FocusNetworkEditorArgs) {
  return guardTd(
    () => ctx.client.focusEditor(args.paths, args.animate),
    (result) =>
      jsonResult(
        `Framed ${result.focused.length} operator(s) in the Network Editor${
          result.pane ? ` (${result.pane})` : ""
        }.`,
        result,
      ),
  );
}

export const registerFocusNetworkEditor: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "focus_network_editor",
    {
      title: "Focus the Network Editor",
      description:
        "Pan/zoom TouchDesigner's Network Editor to frame the given operators — a 'follow' move so the artist sees what the agent just built instead of hunting for it. UI-only: it points a Network Editor pane at the operators' parent, selects them, and homes on the selection with zoom. Changes nothing in the project graph.",
      inputSchema: focusNetworkEditorSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => focusNetworkEditorImpl(ctx, args),
  );
};
