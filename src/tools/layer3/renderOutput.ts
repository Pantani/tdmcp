import { z } from "zod";
import { guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const renderOutputSchema = z.object({
  node_path: z.string().describe("Path of the TOP to render to a file."),
  file: z
    .string()
    .describe(
      "Output file path (written by TouchDesigner, so on the TD machine). Extension picks the format: .png/.jpg/.exr/.tiff. Use an absolute path.",
    ),
});
type RenderOutputArgs = z.infer<typeof renderOutputSchema>;

// Save a TOP straight to disk at its native resolution (unlike get_preview, which transfers a
// small composited PNG over the bridge). Goes through the first-class
// `POST /api/nodes/<path>/save` route (survives TDMCP_BRIDGE_ALLOW_EXEC=0), with a
// transparent `/api/exec` fallback baked into `client.saveNode` for older bridges.
export async function renderOutputImpl(ctx: ToolContext, args: RenderOutputArgs) {
  return guardTd(
    () => ctx.client.saveNode(args.node_path, args.file),
    (report) => {
      const dims = report.has_dimensions ? ` (${report.width}×${report.height})` : "";
      return jsonResult(`Rendered ${args.node_path}${dims} to ${report.saved}.`, report);
    },
  );
}

export const registerRenderOutput: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "render_output",
    {
      title: "Render output to file",
      description:
        "Save a TOP to an image file at its native, full resolution (PNG/JPG/EXR/TIFF by extension) — for exporting a finished frame, unlike get_preview which only transfers a small inline thumbnail. The file is written by TouchDesigner on the TD machine; pass an absolute path.",
      inputSchema: renderOutputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => renderOutputImpl(ctx, args),
  );
};
