import { capturePreview } from "../../feedback/previewCapture.js";
import type { TouchDesignerClient } from "../../td-client/touchDesignerClient.js";
import type { Vault } from "../../vault/index.js";

export interface ThumbnailResult {
  /** Vault-relative path of the written PNG, or null when no thumbnail was produced. */
  imageRel: string | null;
  /** Obsidian embed line `![[<file>.png]]`, or "" when no thumbnail was produced. */
  embed: string;
  /** Non-fatal reason the thumbnail was skipped (offline, perform mode, no TOP found, write failed). */
  warning?: string;
}

export interface CaptureThumbnailOptions {
  /** Output TOP to capture. When omitted, no capture is attempted (embed = ""). */
  topPath?: string;
  /** PNG width  (default 480). */
  width?: number;
  /** PNG height (default 270). */
  height?: number;
}

/**
 * Capture a preview PNG for a saved library asset and write it next to the note.
 *
 * NEVER throws — every failure (bridge offline, perform mode, missing TOP, write
 * error) is swallowed into `{ imageRel:null, embed:"", warning }` so the calling
 * save tool always still writes its note. Writes `<dir>/<baseName>.png` and returns
 * the Obsidian wikilink embed `![[<baseName>.png]]` (relative to the note, which
 * lives in the same `<dir>`).
 */
export async function captureThumbnail(
  client: TouchDesignerClient | undefined,
  vault: Vault,
  dir: string,
  baseName: string,
  opts: CaptureThumbnailOptions = {},
): Promise<ThumbnailResult> {
  const { topPath, width = 480, height = 270 } = opts;

  // 1. No output TOP resolved — cheap no-op, no bridge call.
  if (!topPath) {
    return { imageRel: null, embed: "", warning: "No output TOP to thumbnail." };
  }

  // 2. No client (bridge not configured) — skip, never throw.
  if (!client) {
    return { imageRel: null, embed: "", warning: "TD not connected; thumbnail skipped." };
  }

  // 3. Capture → write → embed, swallowing every failure into a warning.
  try {
    const preview = await capturePreview(client, topPath, width, height);
    const pngRel = `${dir}/${baseName}.png`;
    vault.writeBinary(pngRel, Buffer.from(preview.base64, "base64"));
    return { imageRel: pngRel, embed: `![[${baseName}.png]]` };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { imageRel: null, embed: "", warning: `Thumbnail skipped: ${reason}` };
  }
}

/**
 * Pick the output TOP of a captured recipe: the last node whose type ends in "TOP",
 * else the last node, expressed as "<compPath>/<nodeName>". Returns undefined when
 * there are no nodes (caller then skips the thumbnail).
 */
export function resolveOutputTop(
  nodes: Array<{ name: string; type: string }>,
  compPath: string,
): string | undefined {
  if (nodes.length === 0) return undefined;
  let chosen: { name: string; type: string } | undefined;
  for (const node of nodes) {
    if (node.type.endsWith("TOP")) chosen = node;
  }
  if (!chosen) chosen = nodes[nodes.length - 1];
  if (!chosen) return undefined;
  return `${compPath}/${chosen.name}`;
}

/**
 * Insert `block` immediately after a YAML frontmatter fence (`---\n…\n---\n`).
 * When the markdown has no frontmatter, prepend `block`. Pure string op.
 */
export function injectAfterFrontmatter(markdown: string, block: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(markdown);
  if (!match) return block + markdown;
  const end = match[0].length;
  return markdown.slice(0, end) + block + markdown.slice(end);
}
