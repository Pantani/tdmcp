/**
 * Project RAG — composite scoring (F1 "basic" pass).
 *
 * Computes a 0..1 composite from four axes — `technical`, `license`,
 * `freshness`, `reliability` — weighted by the configured score weights. The
 * IndexStore later multiplies `cosineSim * composite` to rank search results.
 *
 * F1 keeps the formula deliberately simple; F2 tunes weights against a small
 * ground-truth set.
 */

import { isCopyleftLicense, licenseScore } from "./licensePolicy.js";
import type { ProjectRagCard, ProjectRagConfig, ProjectScore } from "./types.js";

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
/**
 * Light tie-breaker penalty applied to copyleft cards AFTER the weighted sum.
 * Does NOT block GPL results — only nudges them below an equally-relevant
 * permissive card. Tuned against the F2 ground-truth set.
 */
const COPYLEFT_PENALTY = 0.05;
/**
 * Curated source boost (multiplier added to reliability). Cards whose
 * `provenance.sourceName` matches a curated source (e.g. tdmcp's default
 * seed list) get a small bump so well-known authoritative repos surface first.
 */
const CURATED_BOOST = 0.1;

/**
 * Source names treated as curated. Kept aligned with
 * {@link DEFAULT_GITHUB_REPOS} so the default seed wins ties against
 * topic-discovered repos of the same relevance.
 */
const CURATED_SOURCE_NAMES: ReadonlySet<string> = new Set([
  "github:torinmb/mediapipe-touchdesigner",
  "github:DBraun/TouchDesigner_Shared",
]);

export function computeProjectScore(
  card: ProjectRagCard,
  weights: ProjectRagConfig["scoreWeights"],
): ProjectScore {
  const technical = computeTechnical(card);
  const license = licenseScore(card.license);
  const freshness = computeFreshness(card);
  const reliability = computeReliability(card);
  const baseComposite =
    weights.technical * technical +
    weights.license * license +
    weights.freshness * freshness +
    weights.reliability * reliability;
  const copyleftPenalty = isCopyleftLicense(card.license) ? COPYLEFT_PENALTY : 0;
  const composite = clamp01(baseComposite - copyleftPenalty);
  return { technical, license, freshness, reliability, composite };
}

/**
 * True when this card's provenance matches a curated/official source list.
 * Exposed for tests and for the reliability bump.
 */
export function isCuratedSource(sourceName: string): boolean {
  return CURATED_SOURCE_NAMES.has(sourceName);
}

function computeTechnical(card: ProjectRagCard): number {
  const mixTotal = Object.values(card.operatorMix ?? {}).reduce((sum, n) => sum + n, 0);
  // log10 normalisation: 0 ops → 0, 10 ops → ~0.33, 100 ops → ~0.66, 1000+ ops → 1.0
  const opsAxis = clamp01(Math.log10(mixTotal + 1) / 3);
  const filesCount = card.operators?.length ?? 0;
  // Card with discovered top-level .tox/.toe filenames gets a flat bonus.
  const filesBonus = filesCount > 0 ? 0.15 : 0;
  const exposedParamsBonus = (card.exposedParams?.length ?? 0) > 0 ? 0.2 : 0;
  const scriptsBonus = (card.scriptsDat?.length ?? 0) > 0 ? 0.1 : 0;
  const previewBonus = card.previewPath !== undefined ? 0.2 : 0;
  // body-length proxy when no operators were extracted yet (F1 source ships READMEs).
  const bodyBonus = card.body !== undefined && card.body.length > 200 ? 0.15 : 0;
  return clamp01(
    opsAxis * 0.5 + filesBonus + exposedParamsBonus + scriptsBonus + previewBonus + bodyBonus,
  );
}

function computeFreshness(card: ProjectRagCard): number {
  const reference = pickTimestamp(card);
  if (reference === undefined) return 0.5;
  const ageMs = Math.max(0, Date.now() - reference.getTime());
  return clamp01(Math.exp(-ageMs / ONE_YEAR_MS));
}

function pickTimestamp(card: ProjectRagCard): Date | undefined {
  const raw = card.provenance.fetchedAt;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function computeReliability(card: ProjectRagCard): number {
  let base: number;
  if (card.licenseConfidence === "declared" || card.licenseConfidence === "spdx-detected") {
    base = 0.85;
  } else if (card.licenseConfidence === "heuristic") {
    base = 0.6;
  } else {
    base = 0.4;
  }
  if (isCuratedSource(card.provenance.sourceName)) {
    base = clamp01(base + CURATED_BOOST);
  }
  return base;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
