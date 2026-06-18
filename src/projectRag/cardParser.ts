/**
 * Project RAG — Markdown(+YAML frontmatter) <-> {@link ProjectRagCard}.
 *
 * Same shape as the Creative RAG card file (YAML frontmatter + body markdown),
 * but validated against the v2 schema with REQUIRED `provenance` + `license`.
 * Embedding vectors are NEVER written to the card file — they live in the JSONL
 * index — so a re-embed of textually unchanged content stays a cache hit.
 */

import { createHash } from "node:crypto";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { ProjectRagCardSchema } from "./schema.js";
import type { ProjectRagCard } from "./types.js";

const FRONTMATTER_DELIMITER = "---";

/** Stable card id: lowercase hex sha256 of `provenance.canonical`. */
export function computeProjectId(canonical: string): string {
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Canonical content hash for the embed cache. Excludes `embedding`,
 * `embeddingModel`, `contentHash`, and the volatile `provenance.fetchedAt`
 * timestamp — re-syncing the same source twice MUST hit the cache.
 */
export function computeProjectContentHash(card: ProjectRagCard): string {
  const canonical = canonicalForHash(card);
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

export function serializeProjectCard(card: ProjectRagCard): string {
  const { body, embeddingModel: _embeddingModel, ...rest } = card;
  const frontmatter = stringifyYaml(stripUndefined(rest)).trimEnd();
  const bodyText = body ?? "";
  return `${FRONTMATTER_DELIMITER}\n${frontmatter}\n${FRONTMATTER_DELIMITER}\n${bodyText}`;
}

export function parseProjectCard(markdown: string): ProjectRagCard {
  const { frontmatter, body } = splitFrontmatter(markdown);
  const data = (parseYaml(frontmatter) ?? {}) as Record<string, unknown>;
  const merged = body.length > 0 ? { ...data, body } : data;
  return ProjectRagCardSchema.parse(merged);
}

function splitFrontmatter(markdown: string): { frontmatter: string; body: string } {
  const normalized = markdown.replace(/\r\n/g, "\n");
  if (!normalized.startsWith(`${FRONTMATTER_DELIMITER}\n`)) {
    throw new Error("Project RAG card is missing a YAML frontmatter block");
  }
  const rest = normalized.slice(FRONTMATTER_DELIMITER.length + 1);
  const closeIndex = rest.indexOf(`\n${FRONTMATTER_DELIMITER}`);
  if (closeIndex === -1) {
    throw new Error("Project RAG card has an unterminated frontmatter block");
  }
  const frontmatter = rest.slice(0, closeIndex);
  const afterClose = rest.slice(closeIndex + 1 + FRONTMATTER_DELIMITER.length);
  const body = afterClose.startsWith("\n") ? afterClose.slice(1) : afterClose;
  return { frontmatter, body };
}

function canonicalForHash(card: ProjectRagCard): Record<string, unknown> {
  // Provenance contributes everything EXCEPT fetchedAt (which changes per sync run).
  const provenanceForHash = {
    sourceName: card.provenance.sourceName,
    sourceUrl: card.provenance.sourceUrl,
    canonical: card.provenance.canonical,
    commitOrVersion: card.provenance.commitOrVersion,
    pathInRepo: card.provenance.pathInRepo,
  };
  return stripUndefined({
    schemaVersion: card.schemaVersion,
    id: card.id,
    kind: card.kind,
    type: card.type,
    title: card.title,
    tags: card.tags,
    provenance: stripUndefined(provenanceForHash),
    license: card.license,
    licenseConfidence: card.licenseConfidence,
    licenseFile: card.licenseFile,
    rightsNotes: card.rightsNotes,
    authors: card.authors,
    tdVersionMin: card.tdVersionMin,
    tdVersionTested: card.tdVersionTested,
    platforms: card.platforms,
    operatorMix: card.operatorMix,
    operators: card.operators,
    exposedParams: card.exposedParams,
    scriptsDat: card.scriptsDat,
    dependencies: card.dependencies,
    // binaryPath / binaryHash / previewPath / analysisStatus are persistence
    // metadata. Excluding them keeps a re-sync that re-downloads the same
    // binary or re-runs the bridge analyzer a cache hit instead of triggering
    // a spurious re-embed.
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
