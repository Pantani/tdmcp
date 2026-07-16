import { z } from "zod";
import { guardTd, structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const getEditorContextSchema = z.object({});
type GetEditorContextArgs = z.infer<typeof getEditorContextSchema>;

export async function getEditorContextImpl(ctx: ToolContext, _args: GetEditorContextArgs = {}) {
  return guardTd(
    () => ctx.client.getEditorContext(),
    (context) => {
      const mode = context.perform_mode === true ? "perform mode" : "editor mode";
      const warningSuffix = context.warnings?.length
        ? ` ${context.warnings.length} field availability warning(s).`
        : "";
      return structuredResult(
        `Read compact TouchDesigner editor context in ${mode}.${warningSuffix}`,
        context,
      );
    },
  );
}

export const registerGetEditorContext: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "get_editor_context",
    {
      title: "Get TouchDesigner editor context",
      description:
        "Read compact project and editor state for references such as 'this node', 'the selected node', and 'place it here'. Returns only available project/build, perform mode, pane, active Network Editor, current/selected, rollover and viewport fields; unavailable UI fields are omitted with warnings instead of inferred. Does not dump project topology or mutate TouchDesigner.",
      inputSchema: getEditorContextSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    (args) => getEditorContextImpl(ctx, args),
  );
};
