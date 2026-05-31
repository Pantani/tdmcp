import { z } from "zod";
import {
  compactStyleContext,
  ENERGY_LEVELS,
  mergeStyleMemory,
  PaletteSchema,
  readStyleMemory,
  STYLE_NOTE_REL,
  type StyleMemory,
  writeStyleMemory,
} from "../../vault/memoryNote.js";
import { jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { requireVault } from "./shared.js";

/**
 * `style_memory` reads, updates, or summarises the standing style note
 * (`Memory/style.md`) — the long-lived record of the artist's preferences
 * (palettes, default energy, banned moves, favourite generators, naming/layout
 * conventions, tags). Writes go through the foundation helpers so frontmatter
 * stays canonical, dedup/sort happens server-side, and `updated` is bumped.
 */
export const styleMemorySchema = z.object({
  mode: z
    .enum(["show", "read", "update"])
    .default("show")
    .describe(
      "show: short compact context string (cheap to feed an LLM). read: full structured note. update: field-wise merge a patch (palettes/banned/favorites union+dedup; scalars overwrite).",
    ),
  patch: z
    .object({
      palettes: z.array(PaletteSchema).optional(),
      default_energy: z.enum(ENERGY_LEVELS).optional(),
      banned: z.array(z.string()).optional(),
      favorite_generators: z.array(z.string()).optional(),
      naming: z.string().optional(),
      layout: z.string().optional(),
      tags: z.array(z.string()).optional(),
    })
    .optional()
    .describe("Patch applied when mode='update'. Ignored for show/read."),
});

export type StyleMemoryArgs = z.infer<typeof styleMemorySchema>;

function summariseShow(value: StyleMemory): string {
  const ctx = compactStyleContext(value);
  return ctx.length > 0 ? `Style context: ${ctx}` : "Style memory is empty.";
}

function summariseRead(value: StyleMemory): string {
  const counts = [
    `${value.palettes.length} palette(s)`,
    `${value.banned.length} banned`,
    `${value.favorite_generators.length} favourite(s)`,
    `${value.tags.length} tag(s)`,
  ].join(", ");
  return `Style memory at ${STYLE_NOTE_REL}: ${counts}.`;
}

export async function styleMemoryImpl(ctx: ToolContext, args: StyleMemoryArgs) {
  const v = requireVault(ctx);
  if ("error" in v) return v.error;
  const { vault } = v;

  if (args.mode === "update") {
    const patch = args.patch ?? {};
    // Write an empty-body default note on first use so the foundation has a body to preserve.
    if (!vault.exists(STYLE_NOTE_REL)) {
      writeStyleMemory(vault, readStyleMemory(vault));
    }
    const merged = mergeStyleMemory(vault, patch);
    return jsonResult(`Updated ${STYLE_NOTE_REL}.`, {
      note: STYLE_NOTE_REL,
      style: merged,
      context: compactStyleContext(merged),
    });
  }

  const current = readStyleMemory(vault);
  if (args.mode === "read") {
    return jsonResult(summariseRead(current), {
      note: STYLE_NOTE_REL,
      style: current,
    });
  }
  return jsonResult(summariseShow(current), {
    note: STYLE_NOTE_REL,
    context: compactStyleContext(current),
  });
}

export const registerStyleMemory: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "style_memory",
    {
      title: "Read or update the artist's standing style memory",
      description:
        "READ or UPDATE the long-lived Memory/style.md note in the configured Obsidian vault — the artist's standing preferences across sessions (palettes, default energy, banned moves, favourite generators, naming/layout conventions, tags). mode='show' returns a compact one-line context string suitable for feeding an LLM, 'read' returns the full structured note, 'update' field-wise merges a patch (lists union+dedup, scalars overwrite) and bumps the `updated` date. Touches the vault only — no TouchDesigner side effects. Requires TDMCP_VAULT_PATH.",
      inputSchema: styleMemorySchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    (args) => styleMemoryImpl(ctx, args),
  );
};
