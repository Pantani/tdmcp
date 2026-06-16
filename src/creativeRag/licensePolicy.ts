/**
 * Creative RAG — license policy (pure).
 *
 * Decides, at sync time, whether a binary (image) may be stored, and classifies
 * each source's raw license signal into a {@link CreativeRagLicense}. There is no
 * runtime prompt or override: the policy is a pure function of the card's license.
 * A source with no license signal yields `Unknown`, and the downloader must skip
 * the binary.
 */

import type { CreativeRagLicense } from "./types.js";

/**
 * True when a binary may be stored for `license` given the configured allowlist.
 * Default allowlist (decided by config) is `["CC0", "PublicDomain"]`.
 */
export function shouldStoreBinary(
  license: CreativeRagLicense,
  allowlist: CreativeRagLicense[],
): boolean {
  return allowlist.includes(license);
}

/** Art Institute of Chicago: `is_public_domain` boolean ⇒ PublicDomain, else Unknown. */
export function classifyArticLicense(isPublicDomain: boolean): CreativeRagLicense {
  return isPublicDomain ? "PublicDomain" : "Unknown";
}

/** The Met: `isPublicDomain` boolean ⇒ PublicDomain, else Unknown. */
export function classifyMetLicense(isPublicDomain: boolean): CreativeRagLicense {
  return isPublicDomain ? "PublicDomain" : "Unknown";
}

/**
 * Rijksmuseum: map a Linked-Art rights signal to a license.
 *
 * The real `data.rijksmuseum.nl` shape carries the license as a Creative Commons
 * URI (`Right.classified_as[].id`), e.g.
 * `https://creativecommons.org/publicdomain/zero/1.0/`. This classifier maps those
 * URIs first, then falls back to plain-text statements (kept for robustness):
 * CC0 ⇒ CC0; public-domain ⇒ PublicDomain; by-sa ⇒ CC-BY-SA; by ⇒ CC-BY;
 * unknown/empty ⇒ Unknown.
 */
export function classifyRijksLicense(rights?: string): CreativeRagLicense {
  if (!rights) return "Unknown";
  const text = rights.trim().toLowerCase();
  if (text.length === 0) return "Unknown";

  // Creative Commons URI mapping (the real Rijksmuseum shape).
  if (text.includes("creativecommons.org/publicdomain/zero")) return "CC0";
  if (text.includes("creativecommons.org/publicdomain/mark")) return "PublicDomain";
  if (text.includes("creativecommons.org/licenses/by-sa")) return "CC-BY-SA";
  if (text.includes("creativecommons.org/licenses/by")) return "CC-BY";

  // Plain-text fallback (docs-assumed shape, kept for robustness).
  if (text.includes("cc0") || text.includes("creative commons zero")) return "CC0";
  if (text.includes("public domain") || text.includes("publicdomain")) return "PublicDomain";
  return "Unknown";
}
