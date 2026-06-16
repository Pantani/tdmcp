/**
 * Creative RAG — Zod schema for a {@link CreativeRagCard}.
 *
 * The schema mirrors the `types.ts` contract exactly (single source of truth).
 * `schemaVersion` is pinned to the literal `1`; `license`/`type` are enums reused
 * by other builders (C & D) so there is one canonical list of allowed values.
 */

import { z } from "zod";
import type { CreativeRagCard } from "./types.js";

/** Allowed license values — reused by the source adapters and index store. */
export const CreativeRagLicenseSchema = z.enum([
  "CC0",
  "PublicDomain",
  "CC-BY",
  "CC-BY-SA",
  "Unknown",
  "Restricted",
]);

/** Allowed card types — reused by the source adapters and index store. */
export const CreativeRagTypeSchema = z.enum([
  "project",
  "artist",
  "artwork",
  "technique",
  "cue_reference",
]);

/**
 * Validates a parsed card. `tools`/`tags`/`tdmcpAffordances` default to `[]` so a
 * card file may omit them entirely; optional descriptive fields stay `.optional()`.
 */
export const CreativeRagCardSchema: z.ZodType<CreativeRagCard> = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  type: CreativeRagTypeSchema,
  title: z.string(),
  artist: z.string().optional(),
  sourceUrl: z.string(),
  sourceName: z.string(),
  license: CreativeRagLicenseSchema,
  rightsNotes: z.string().optional(),
  year: z.number().optional(),
  medium: z.string().optional(),
  tools: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  visualLanguage: z.string().optional(),
  motionLanguage: z.string().optional(),
  interaction: z.string().optional(),
  materials: z.string().optional(),
  lighting: z.string().optional(),
  palette: z.array(z.string()).optional(),
  tdmcpAffordances: z.array(z.string()).default([]),
  contentHash: z.string(),
  embeddingModel: z.string().optional(),
  embedding: z.array(z.number()).optional(),
  tombstone: z.boolean().optional(),
  body: z.string().optional(),
});
