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
 * Rijksmuseum: map a Linked-Art rights statement string to a license.
 * CC0 text ⇒ CC0; public-domain text ⇒ PublicDomain; unknown/empty ⇒ Unknown.
 */
export function classifyRijksLicense(rightsStatement?: string): CreativeRagLicense {
  if (!rightsStatement) return "Unknown";
  const text = rightsStatement.trim().toLowerCase();
  if (text.length === 0) return "Unknown";
  if (text.includes("cc0") || text.includes("creative commons zero")) return "CC0";
  if (text.includes("public domain") || text.includes("publicdomain")) return "PublicDomain";
  return "Unknown";
}
