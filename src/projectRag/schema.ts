/**
 * Project RAG — Zod schema for a {@link ProjectRagCard}.
 *
 * Mirrors `types.ts` exactly. `provenance` and `license` are REQUIRED; a card
 * file missing either is rejected at parse time. License/type enums reused by
 * sources + index store.
 */

import { z } from "zod";
import type {
  ExposedParam,
  ProjectDependencies,
  ProjectProvenance,
  ProjectRagCard,
  ScriptDat,
} from "./types.js";

export const ProjectRagLicenseSchema = z.enum([
  "CC0",
  "PublicDomain",
  "CC-BY",
  "CC-BY-SA",
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "MPL-2.0",
  "GPL-2.0",
  "GPL-3.0",
  "LGPL-2.1",
  "LGPL-3.0",
  "AGPL-3.0",
  "Derivative-EULA",
  "Proprietary-Free",
  "Proprietary-Paid",
  "Unknown",
  "Restricted",
]);

export const ProjectRagTypeSchema = z.enum([
  "project",
  "component",
  "snippet",
  "tutorial",
  "custom-op",
  "framework",
]);

export const LicenseConfidenceSchema = z.enum([
  "declared",
  "spdx-detected",
  "heuristic",
  "unknown",
]);

export const ProjectProvenanceSchema: z.ZodType<ProjectProvenance> = z.object({
  sourceName: z.string().min(1),
  sourceUrl: z.string().min(1),
  canonical: z.string().min(1),
  commitOrVersion: z.string().optional(),
  pathInRepo: z.string().optional(),
  fetchedAt: z.string().min(1),
});

export const ProjectScoreSchema = z.object({
  technical: z.number(),
  license: z.number(),
  freshness: z.number(),
  reliability: z.number(),
  composite: z.number(),
});

const ExposedParamSchema: z.ZodType<ExposedParam> = z.object({
  name: z.string(),
  type: z.string(),
  default: z.string().optional(),
});

const ScriptDatSchema: z.ZodType<ScriptDat> = z.object({
  name: z.string(),
  path: z.string(),
  lang: z.enum(["python", "glsl", "text"]),
});

const DependenciesSchema: z.ZodType<ProjectDependencies> = z.object({
  python: z.array(z.string()).optional(),
  customOps: z.array(z.string()).optional(),
  externalFiles: z.array(z.string()).optional(),
});

export const ProjectRagCardSchema: z.ZodType<ProjectRagCard> = z.object({
  schemaVersion: z.literal(2),
  id: z.string().min(1),
  kind: z.literal("project"),
  type: ProjectRagTypeSchema,
  title: z.string().min(1),
  body: z.string().optional(),
  tags: z.array(z.string()).default([]),
  contentHash: z.string(),
  embeddingModel: z.string().optional(),
  tombstone: z.boolean().optional(),

  provenance: ProjectProvenanceSchema,
  license: ProjectRagLicenseSchema,
  licenseConfidence: LicenseConfidenceSchema,
  licenseFile: z.string().optional(),
  rightsNotes: z.string().optional(),

  authors: z.array(z.string()).optional(),
  tdVersionMin: z.string().optional(),
  tdVersionTested: z.array(z.string()).optional(),
  platforms: z.array(z.enum(["win", "mac", "linux"])).optional(),
  operatorMix: z.record(z.string(), z.number()).optional(),
  operators: z.array(z.string()).optional(),
  exposedParams: z.array(ExposedParamSchema).optional(),
  scriptsDat: z.array(ScriptDatSchema).optional(),
  dependencies: DependenciesSchema.optional(),
  binaryHash: z.string().optional(),
  binaryPath: z.string().optional(),
  previewPath: z.string().optional(),
  score: ProjectScoreSchema.optional(),
  tdmcpAffordances: z.array(z.string()).optional(),
  analysisStatus: z.enum(["ok", "failed", "skipped"]).optional(),
  analysisReason: z.string().optional(),
});
