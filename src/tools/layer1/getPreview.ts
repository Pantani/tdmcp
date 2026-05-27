import { z } from "zod";
import { capturePreview } from "../../feedback/previewCapture.js";
import { guardTd, imageResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const getPreviewSchema = z.object({
  node_path: z.string().describe("Path of the TOP node to capture."),
  width: z.coerce.number().int().positive().max(4096).default(640),
  height: z.coerce.number().int().positive().max(4096).default(360),
});
type GetPreviewArgs = z.infer<typeof getPreviewSchema>;

export async function getPreviewImpl(ctx: ToolContext, args: GetPreviewArgs) {
  return guardTd(
    () => capturePreview(ctx.client, args.node_path, args.width, args.height),
    (preview) =>
      imageResult(
        preview.base64,
        preview.mimeType,
        `Preview of ${args.node_path} (${preview.width}×${preview.height}).`,
      ),
  );
}

export const registerGetPreview: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "get_preview",
    {
      title: "Preview a TOP",
      description: "Capture a TOP node as an inline image so you can see what was created.",
      inputSchema: getPreviewSchema.shape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => getPreviewImpl(ctx, args),
  );
};
