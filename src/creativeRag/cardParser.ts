/**
 * Creative RAG — Markdown(+YAML frontmatter) <-> {@link CreativeRagCard}.
 *
 * A card on disk is a Markdown file: a `---`-delimited YAML frontmatter block
 * carrying the structured fields, followed by the free-text `body`. The
 * `embedding` vector is NEVER written to the card file — it lives in the JSONL
 * index — so re-embedding a textually unchanged card stays a cache hit.
 */

import { createHash } from "node:crypto";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { CreativeRagCardSchema } from "./schema.js";
import type { CreativeRagCard } from "./types.js";

const FRONTMATTER_DELIMITER = "---";

/** Stable card id: lowercase hex sha256 of the source URL. */
export function computeId(sourceUrl: string): string {
  return createHash("sha256").update(sourceUrl, "utf8").digest("hex");
}

/**
 * Canonical content hash used for the embed cache. It serializes the card's
 * meaningful fields in a fixed order, EXCLUDING `embedding`, `embeddingModel`
 * and `contentHash` itself, so a re-embed of unchanged text reuses the cache.
 */
export function computeContentHash(card: CreativeRagCard): string {
  const canonical = canonicalForHash(card);
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

/**
 * Serializes a card to a Markdown file: YAML frontmatter + body. `embedding`,
 * `embeddingModel` and `body` are kept out of the frontmatter (`body` becomes
 * the Markdown content; the embedding lives only in the index).
 */
export function serializeCard(card: CreativeRagCard): string {
  const { body, embedding: _embedding, embeddingModel: _embeddingModel, ...rest } = card;
  const frontmatter = stringifyYaml(stripUndefined(rest)).trimEnd();
  const bodyText = body ?? "";
  return `${FRONTMATTER_DELIMITER}\n${frontmatter}\n${FRONTMATTER_DELIMITER}\n${bodyText}`;
}

/**
 * Parses a Markdown card file back into a validated {@link CreativeRagCard}.
 * The body (everything after the closing `---`) is attached as `body` only when
 * non-empty, so the round-trip with {@link serializeCard} is an identity.
 */
export function parseCard(markdown: string): CreativeRagCard {
  const { frontmatter, body } = splitFrontmatter(markdown);
  const data = parseYaml(frontmatter) ?? {};
  const merged = body.length > 0 ? { ...data, body } : data;
  return CreativeRagCardSchema.parse(merged);
}

function splitFrontmatter(markdown: string): { frontmatter: string; body: string } {
  const normalized = markdown.replace(/\r\n/g, "\n");
  if (!normalized.startsWith(`${FRONTMATTER_DELIMITER}\n`)) {
    throw new Error("Creative RAG card is missing a YAML frontmatter block");
  }
  const rest = normalized.slice(FRONTMATTER_DELIMITER.length + 1);
  const closeIndex = rest.indexOf(`\n${FRONTMATTER_DELIMITER}`);
  if (closeIndex === -1) {
    throw new Error("Creative RAG card has an unterminated frontmatter block");
  }
  const frontmatter = rest.slice(0, closeIndex);
  const afterClose = rest.slice(closeIndex + 1 + FRONTMATTER_DELIMITER.length);
  const body = afterClose.startsWith("\n") ? afterClose.slice(1) : afterClose;
  return { frontmatter, body };
}

/** Field-ordered projection of the hashable fields (no embedding/hash fields). */
function canonicalForHash(card: CreativeRagCard): Record<string, unknown> {
  return stripUndefined({
    schemaVersion: card.schemaVersion,
    id: card.id,
    type: card.type,
    title: card.title,
    artist: card.artist,
    sourceUrl: card.sourceUrl,
    sourceName: card.sourceName,
    license: card.license,
    rightsNotes: card.rightsNotes,
    year: card.year,
    medium: card.medium,
    tools: card.tools,
    tags: card.tags,
    visualLanguage: card.visualLanguage,
    motionLanguage: card.motionLanguage,
    interaction: card.interaction,
    materials: card.materials,
    lighting: card.lighting,
    palette: card.palette,
    tdmcpAffordances: card.tdmcpAffordances,
    tombstone: card.tombstone,
    body: card.body,
  });
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}
