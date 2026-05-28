import { z } from "zod";
import { capturePreview } from "../../feedback/previewCapture.js";
import { guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { readNoteSafe, requireVault } from "./shared.js";

export const captureToVaultSchema = z.object({
  node_path: z.string().describe("TOP to capture a still from."),
  gallery: z.string().default("Gallery").describe("Vault subfolder for the gallery note + images."),
  note: z
    .string()
    .optional()
    .describe(
      "Gallery note name (defaults to today's date, so captures accumulate into one daily look-book).",
    ),
  caption: z.string().optional().describe("Caption for this capture."),
  width: z.coerce.number().int().default(640).describe("Capture width."),
  height: z.coerce.number().int().default(360).describe("Capture height."),
});
type CaptureToVaultArgs = z.infer<typeof captureToVaultSchema>;

/** ISO timestamp suitable for a filename: YYYY-MM-DDTHHmmss */
function fileStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/** YYYY-MM-DD for default note name and frontmatter. */
function dateStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export async function captureToVaultImpl(
  ctx: ToolContext,
  args: CaptureToVaultArgs,
): Promise<ReturnType<typeof jsonResult>> {
  const v = requireVault(ctx);
  if ("error" in v) return v.error;
  const { vault } = v;

  const now = new Date();
  const noteName = args.note ?? dateStamp(now);
  const noteRel = `${args.gallery}/${noteName}.md`;
  const imageFile = `${fileStamp(now)}.png`;
  const imageRel = `${args.gallery}/images/${imageFile}`;

  return guardTd(
    async () => {
      const preview = await capturePreview(ctx.client, args.node_path, args.width, args.height);
      return { preview };
    },
    ({ preview }) => {
      const warnings: string[] = [];

      // Write the PNG bytes into the vault.
      vault.writeBinary(imageRel, Buffer.from(preview.base64, "base64"));

      // Determine how many images the note already has (count existing ![[...]] lines).
      let imageCount = 1;
      let existingBody = "";
      let existingData: Record<string, unknown> = {};

      if (vault.exists(noteRel)) {
        const read = readNoteSafe(vault, noteRel);
        if ("error" in read) {
          warnings.push(`Could not read existing note: ${read.error.content[0]}`);
        } else {
          existingData = read.data;
          existingBody = read.body;
          // Count existing image embeds to number the new one.
          const embedMatches = existingBody.match(/!\[\[images\//g);
          imageCount = (embedMatches?.length ?? 0) + 1;
        }
      }

      // Build the new image block to append.
      const captionLine = args.caption ? `\n_${args.caption}_` : "";
      const newBlock =
        `\n## Capture ${imageCount} — ${now.toISOString()}\n\n` +
        `![[images/${imageFile}]]` +
        captionLine +
        "\n";

      if (vault.exists(noteRel) && !("error" in readNoteSafe(vault, noteRel))) {
        // Note exists — append the new capture block.
        vault.write(noteRel, `${existingBody.trimEnd()}\n${newBlock}`);
      } else {
        // Note does not exist — create it with frontmatter.
        const data: Record<string, unknown> = {
          type: "gallery",
          created: now.toISOString(),
          gallery: args.gallery,
          ...existingData,
        };
        vault.writeNote(noteRel, data, newBlock.trimStart());
      }

      const summary = `Captured ${args.node_path} → ${noteRel} (image ${imageCount}).`;
      return jsonResult(summary, {
        note: noteRel,
        image: imageRel,
        caption: args.caption ?? null,
        capture_number: imageCount,
        warnings,
      });
    },
  );
}

export const registerCaptureToVault: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "capture_to_vault",
    {
      title: "Capture a still to the vault gallery",
      description:
        "Captures a preview still from a TOP and appends it to a dated gallery note in the Obsidian vault, building a visual look-book over time. Each call writes the PNG image under <gallery>/images/ and appends a new section to <gallery>/<note>.md (defaulting to today's date so all daily captures land in one note). Use this to document looks, reference frames, or build a browsable gallery of your session's visuals. Requires a configured TDMCP_VAULT_PATH.",
      inputSchema: captureToVaultSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => captureToVaultImpl(ctx, args),
  );
};
