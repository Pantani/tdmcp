import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
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

interface RenderReport {
  saved?: string;
  width?: number;
  height?: number;
  fatal?: string;
}

// Save a TOP straight to disk at its native resolution (unlike get_preview, which transfers a
// small composited PNG over the bridge). TOP.save writes on the TD machine.
const RENDER_SCRIPT = `
import json, base64
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
_n = op(_p["node"])
if _n is None:
    print(json.dumps({"fatal": "Node not found: " + _p["node"]}))
elif not hasattr(_n, "save"):
    print(json.dumps({"fatal": _p["node"] + " cannot be saved (not a TOP?)."}))
else:
    try:
        _saved = _n.save(_p["file"], createFolders=True)
        print(json.dumps({"saved": str(_saved) if _saved else _p["file"], "width": int(_n.width), "height": int(_n.height)}))
    except Exception as _e:
        print(json.dumps({"fatal": str(_e)}))
`;

export function buildRenderScript(payload: object): string {
  return buildPayloadScript(RENDER_SCRIPT, payload);
}

export async function renderOutputImpl(ctx: ToolContext, args: RenderOutputArgs) {
  return guardTd(
    async () => {
      const script = buildRenderScript({ node: args.node_path, file: args.file });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<RenderReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) return errorResult(`Render failed: ${report.fatal}`, report);
      return jsonResult(
        `Rendered ${args.node_path} (${report.width}×${report.height}) to ${report.saved}.`,
        report,
      );
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
