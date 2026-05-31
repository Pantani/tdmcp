import { z } from "zod";
import type { Vault } from "./index.js";

/** A named (or anonymous) colour set the artist favours. */
export const PaletteSchema = z.object({
  name: z.string().optional().describe("Optional label for this palette (e.g. 'warm-dusk')."),
  colors: z
    .array(z.string())
    .default([])
    .describe("Hex colours in the palette, e.g. ['#1a1a2e', '#e94560']."),
});
export type Palette = z.infer<typeof PaletteSchema>;

export const ENERGY_LEVELS = ["calm", "medium", "high", "chaotic"] as const;
export type EnergyLevel = (typeof ENERGY_LEVELS)[number];

/** The structured frontmatter of Memory/style.md. All fields optional; sensible empty defaults. */
export const StyleMemorySchema = z.object({
  type: z.literal("tdmcp-memory").default("tdmcp-memory").describe("Note-family discriminator."),
  topic: z.string().default("style").describe("Always 'style' for the standing style note."),
  updated: z
    .string()
    .default("")
    .describe("ISO date (YYYY-MM-DD) of the last write; bumped on every merge."),
  palettes: z
    .array(PaletteSchema)
    .default([])
    .describe("Preferred colour palettes accrued over time."),
  default_energy: z
    .enum(ENERGY_LEVELS)
    .optional()
    .describe("The artist's default intensity when unspecified: calm | medium | high | chaotic."),
  banned: z
    .array(z.string())
    .default([])
    .describe("Moves/effects to never use (the 'never strobe' list); merges are union, dedup."),
  favorite_generators: z
    .array(z.string())
    .default([])
    .describe("Preferred generator tool names (e.g. 'create_feedback_network')."),
  naming: z.string().optional().describe("Naming-convention label, e.g. 'camelCase'."),
  layout: z.string().optional().describe("Layout-convention label, e.g. 'left-to-right'."),
  tags: z
    .array(z.string())
    .default([])
    .describe("Free-form descriptors; SAME tag vocabulary as browse_vault_library / auto_tag."),
});
export type StyleMemory = z.infer<typeof StyleMemorySchema>;

/** Generic Memory/<topic>.md frontmatter — the style note is the typed special case of this. */
export const MemoryNoteSchema = z
  .object({
    type: z.literal("tdmcp-memory").default("tdmcp-memory"),
    topic: z.string().default("memory"),
    updated: z.string().default(""),
    tags: z.array(z.string()).default([]),
  })
  .passthrough()
  .describe("Loose envelope for any Memory/<topic>.md note.");
export type MemoryNoteFrontmatter = z.infer<typeof MemoryNoteSchema>;

export const STYLE_NOTE_REL = "Memory/style.md";

const DEFAULT_STYLE_BODY = "## Style notes\n\n## Conventions\n\n## Log\n";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function slug(input: string): string {
  const cleaned = input.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^[._]+|[._]+$/g, "");
  return cleaned.length > 0 ? cleaned : "memory";
}

/** Vault-relative path for a generic memory note, slug-sanitised. */
export function memoryNoteRel(topic: string): string {
  return `Memory/${slug(topic)}.md`;
}

/** Normalise a frontmatter `tags` value to a deduped lower-cased string[]. */
export function normalizeTags(value: unknown): string[] {
  let raw: string[] = [];
  if (Array.isArray(value)) {
    raw = value.map((t) => String(t).trim()).filter(Boolean);
  } else if (typeof value === "string") {
    raw = value
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  } else {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of raw) {
    const lower = t.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      out.push(lower);
    }
  }
  return out;
}

/** Build a frontmatter object in the canonical key order, dropping undefined scalars. */
function styleToFrontmatter(value: StyleMemory): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  out.type = "tdmcp-memory";
  out.topic = value.topic || "style";
  out.updated = value.updated;
  out.palettes = value.palettes.map((p) => {
    const entry: Record<string, unknown> = {};
    if (p.name !== undefined) entry.name = p.name;
    entry.colors = p.colors;
    return entry;
  });
  if (value.default_energy !== undefined) out.default_energy = value.default_energy;
  out.banned = value.banned;
  out.favorite_generators = value.favorite_generators;
  if (value.naming !== undefined && value.naming !== "") out.naming = value.naming;
  if (value.layout !== undefined && value.layout !== "") out.layout = value.layout;
  out.tags = value.tags;
  return out;
}

/** Read + validate Memory/style.md. Returns schema defaults (empty note) if the file is absent. */
export function readStyleMemory(vault: Vault): StyleMemory {
  if (!vault.exists(STYLE_NOTE_REL)) {
    return StyleMemorySchema.parse({});
  }
  const note = vault.readNote(STYLE_NOTE_REL);
  return StyleMemorySchema.parse(note.data);
}

function readStyleBody(vault: Vault): string {
  if (!vault.exists(STYLE_NOTE_REL)) return DEFAULT_STYLE_BODY;
  return vault.readNote(STYLE_NOTE_REL).body;
}

/** Serialize a StyleMemory to frontmatter+body and write Memory/style.md (bumps `updated`). */
export function writeStyleMemory(vault: Vault, value: StyleMemory, body?: string): void {
  const stamped: StyleMemory = { ...value, updated: todayIso() };
  const data = styleToFrontmatter(stamped);
  const finalBody = body ?? readStyleBody(vault);
  vault.writeNote(STYLE_NOTE_REL, data, finalBody);
}

function dedupCi(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const k = v.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(v);
    }
  }
  return out;
}

function mergePalettes(current: Palette[], patch: Palette[]): Palette[] {
  const out = [...current];
  for (const p of patch) {
    const exists = out.some((existing) => {
      if (p.name && existing.name) return p.name === existing.name;
      if (!p.name && !existing.name) {
        return (
          existing.colors.length === p.colors.length &&
          existing.colors.every((c, i) => c === p.colors[i])
        );
      }
      return false;
    });
    if (!exists) out.push(p);
  }
  return out;
}

/** Read current, field-wise-merge the patch, write back. Returns the merged value. */
export function mergeStyleMemory(vault: Vault, patch: Partial<StyleMemory>): StyleMemory {
  const current = readStyleMemory(vault);
  const body = readStyleBody(vault);

  const banned = patch.banned
    ? dedupCi([...current.banned, ...patch.banned]).sort((a, b) => a.localeCompare(b))
    : current.banned;

  const favorite_generators = patch.favorite_generators
    ? dedupCi([...current.favorite_generators, ...patch.favorite_generators])
    : current.favorite_generators;

  const tags = patch.tags ? normalizeTags([...current.tags, ...patch.tags]) : current.tags;

  const palettes = patch.palettes
    ? mergePalettes(current.palettes, patch.palettes)
    : current.palettes;

  const merged: StyleMemory = {
    type: "tdmcp-memory",
    topic: current.topic || "style",
    updated: todayIso(),
    palettes,
    banned,
    favorite_generators,
    tags,
    ...(patch.default_energy !== undefined
      ? { default_energy: patch.default_energy }
      : current.default_energy !== undefined
        ? { default_energy: current.default_energy }
        : {}),
    ...(patch.naming !== undefined && patch.naming !== ""
      ? { naming: patch.naming }
      : current.naming !== undefined
        ? { naming: current.naming }
        : {}),
    ...(patch.layout !== undefined && patch.layout !== ""
      ? { layout: patch.layout }
      : current.layout !== undefined
        ? { layout: current.layout }
        : {}),
  };

  vault.writeNote(STYLE_NOTE_REL, styleToFrontmatter(merged), body);
  return merged;
}

/** Compact token-cheap standing-context string. Frontmatter only. */
export function compactStyleContext(value: StyleMemory): string {
  const parts: string[] = [];
  if (value.default_energy) parts.push(`energy: ${value.default_energy}`);
  if (value.palettes.length > 0) {
    const pal = value.palettes
      .map((p) => {
        const label = p.name ?? "palette";
        return `${label}(${p.colors.join(",")})`;
      })
      .join("; ");
    parts.push(`palettes: ${pal}`);
  }
  if (value.banned.length > 0) parts.push(`banned: ${value.banned.join(", ")}`);
  if (value.favorite_generators.length > 0)
    parts.push(`favorites: ${value.favorite_generators.join(", ")}`);
  if (value.naming) parts.push(`naming: ${value.naming}`);
  if (value.layout) parts.push(`layout: ${value.layout}`);
  if (value.tags.length > 0) parts.push(`tags: ${value.tags.join(", ")}`);
  return parts.join(" | ");
}

/** Generic note read. */
export function readMemoryNote(
  vault: Vault,
  topic: string,
): { data: MemoryNoteFrontmatter; body: string } {
  const rel = memoryNoteRel(topic);
  if (!vault.exists(rel)) {
    return { data: MemoryNoteSchema.parse({ topic: slug(topic) }), body: "" };
  }
  const note = vault.readNote(rel);
  return { data: MemoryNoteSchema.parse(note.data), body: note.body };
}

/** Generic note write. */
export function writeMemoryNote(
  vault: Vault,
  topic: string,
  data: Record<string, unknown>,
  body: string,
): void {
  const rel = memoryNoteRel(topic);
  const merged: Record<string, unknown> = {
    type: "tdmcp-memory",
    topic: slug(topic),
    updated: todayIso(),
    ...data,
  };
  merged.type = "tdmcp-memory";
  merged.updated = todayIso();
  vault.writeNote(rel, merged, body);
}

/** Generic frontmatter merge — shallow Object.assign over the existing data, body preserved. */
export function mergeMemoryFrontmatter(
  vault: Vault,
  topic: string,
  patch: Record<string, unknown>,
  body?: string,
): MemoryNoteFrontmatter {
  const rel = memoryNoteRel(topic);
  const existing = vault.exists(rel) ? vault.readNote(rel) : { data: {}, body: "" };
  const mergedData: Record<string, unknown> = {
    ...existing.data,
    ...patch,
    type: "tdmcp-memory",
    topic: slug(topic),
    updated: todayIso(),
  };
  const finalBody = body ?? existing.body;
  vault.writeNote(rel, mergedData, finalBody);
  return MemoryNoteSchema.parse(mergedData);
}
