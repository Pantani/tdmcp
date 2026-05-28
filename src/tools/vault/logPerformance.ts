import { z } from "zod";
import { verifyNetwork } from "../../feedback/networkVerifier.js";
import { capturePreview } from "../../feedback/previewCapture.js";
import { guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { requireVault } from "./shared.js";

export const logPerformanceSchema = z.object({
  title: z.string().optional().describe("Short title for the entry (e.g. venue or set name)."),
  comp_path: z.string().default("/project1").describe("Network to snapshot for the log."),
  output_path: z.string().optional().describe("TOP to capture as the entry's thumbnail."),
  notes: z.string().optional().describe("Free-form notes: what played, what worked."),
  width: z.coerce
    .number()
    .int()
    .positive()
    .default(640)
    .describe("Thumbnail width in pixels for the captured output_path preview."),
  height: z.coerce
    .number()
    .int()
    .positive()
    .default(360)
    .describe("Thumbnail height in pixels for the captured output_path preview."),
});
type LogPerformanceArgs = z.infer<typeof logPerformanceSchema>;

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function slug(s: string): string {
  return (
    s
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "set"
  );
}

export async function logPerformanceImpl(ctx: ToolContext, args: LogPerformanceArgs) {
  const v = requireVault(ctx);
  if ("error" in v) return v.error;
  const { vault } = v;

  const now = new Date();
  const base = `${stamp(now)}-${slug(args.title ?? "set")}`;

  return guardTd(
    async () => {
      const report = await verifyNetwork(ctx.client, args.comp_path);
      let preview: { base64: string; mimeType: string } | undefined;
      if (args.output_path) {
        try {
          preview = await capturePreview(ctx.client, args.output_path, args.width, args.height);
        } catch {
          preview = undefined; // a missing/uncookable output shouldn't sink the log
        }
      }
      return { report, preview };
    },
    ({ report, preview }) => {
      const noteRel = `Performances/${base}.md`;
      let imageEmbed = "";
      if (preview) {
        const ext = preview.mimeType.includes("jpeg") ? "jpg" : "png";
        vault.writeBinary(
          `Performances/attachments/${base}.${ext}`,
          Buffer.from(preview.base64, "base64"),
        );
        imageEmbed = `![preview](attachments/${base}.${ext})\n\n`;
      }
      const issues = report.issues.length
        ? `## Issues\n\n${report.issues.map((i) => `- ${i}`).join("\n")}\n\n`
        : "";
      const body =
        `# ${args.title ?? "Performance"} — ${now.toISOString().slice(0, 10)}\n\n` +
        imageEmbed +
        (args.notes ? `${args.notes}\n\n` : "") +
        `Network \`${args.comp_path}\`: ${report.nodeCount} operator(s), ${report.connectionCount} connection(s).\n\n` +
        issues;

      const data: Record<string, unknown> = {
        date: now.toISOString(),
        title: args.title ?? "Performance",
        comp: args.comp_path,
        nodes: report.nodeCount,
        connections: report.connectionCount,
        issues: report.issues.length,
        type: "tdmcp-performance",
      };
      if (args.output_path) data.output = args.output_path;
      vault.writeNote(noteRel, data, body);

      return jsonResult(`Logged performance to ${noteRel}${preview ? " (with thumbnail)" : ""}.`, {
        path: noteRel,
        thumbnail: Boolean(preview),
        nodes: report.nodeCount,
        issues: report.issues.length,
      });
    },
  );
}

export const registerLogPerformance: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "log_performance",
    {
      title: "Log a performance to the vault",
      description:
        "READ a snapshot of a TD network (node/connection counts plus any errors) and, optionally, a preview image of an output TOP, then WRITE a dated journal entry to Performances/<date>-<title>.md in the vault (the thumbnail is saved as a binary attachment). Use this to build a diary of your shows over time. Returns the note path, whether a thumbnail was saved, and the node/issue counts. Requires a configured TDMCP_VAULT_PATH.",
      inputSchema: logPerformanceSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => logPerformanceImpl(ctx, args),
  );
};
