/**
 * Project RAG — license policy (pure).
 *
 * Decides whether a binary (`.tox`/`.toe`/`.png`) may be stored locally given
 * the configured allowlist, and provides the license-score axis used by the
 * composite ranker. The matrix mirrors the design doc:
 *
 * | License                | Card | Binary | Preview | Bridge analyze |
 * | CC0/PublicDomain       |  ✅  |   ✅   |   ✅    |       ✅       |
 * | MIT/Apache/BSD/ISC/MPL |  ✅  |   ✅   |   ✅    |       ✅       |
 * | GPL/LGPL/AGPL          |  ✅  |   ✅†  |   ✅    |       ✅       | († copyleft flag)
 * | CC-BY / CC-BY-SA       |  ✅  |   ✅†  |   ✅    |       ✅       | († attribution required)
 * | Derivative-EULA        |  ✅  |   ❌   |   ✅    |       ✅       |
 * | Proprietary-Free       |  ✅  |   ❌   |   ❌    |       ❌       |
 * | Proprietary-Paid       |  ❌  |   ❌   |   ❌    |       ❌       |
 * | Unknown                |  ✅  |   ❌   |   ❌    |       ❌       |
 * | Restricted             |  ❌  |   ❌   |   ❌    |       ❌       |
 */

import type { ProjectRagLicense } from "./types.js";

/** True when a binary may be stored locally for `license`, given the allowlist. */
export function shouldStoreProjectBinary(
  license: ProjectRagLicense,
  allowlist: ProjectRagLicense[],
): boolean {
  if (license === "Proprietary-Paid" || license === "Restricted") return false;
  if (license === "Derivative-EULA") return false; // never redistribute — local-only
  if (license === "Proprietary-Free") return false;
  if (license === "Unknown") return false;
  return allowlist.includes(license);
}

/** True when the card itself (meta + body) may be ingested at all. */
export function shouldIngestProjectCard(license: ProjectRagLicense): boolean {
  return license !== "Proprietary-Paid" && license !== "Restricted";
}

/** Copyleft flag exposed in search results so users see the obligation. */
export function isCopyleftLicense(license: ProjectRagLicense): boolean {
  return (
    license === "GPL-2.0" ||
    license === "GPL-3.0" ||
    license === "LGPL-2.1" ||
    license === "LGPL-3.0" ||
    license === "AGPL-3.0"
  );
}

/** True when bridge-analyze (F3, opt-in) is allowed for this license. */
export function canBridgeAnalyze(license: ProjectRagLicense): boolean {
  if (license === "Proprietary-Free" || license === "Proprietary-Paid") return false;
  if (license === "Unknown" || license === "Restricted") return false;
  return true;
}

/** 0..1 license score axis for the composite ranker. */
export function licenseScore(license: ProjectRagLicense): number {
  switch (license) {
    case "CC0":
    case "PublicDomain":
      return 1.0;
    case "MIT":
    case "Apache-2.0":
    case "BSD-2-Clause":
    case "BSD-3-Clause":
    case "ISC":
    case "MPL-2.0":
      return 0.95;
    case "CC-BY":
    case "CC-BY-SA":
      return 0.8;
    case "Derivative-EULA":
      return 0.85;
    case "GPL-2.0":
    case "GPL-3.0":
    case "LGPL-2.1":
    case "LGPL-3.0":
    case "AGPL-3.0":
      return 0.7;
    case "Proprietary-Free":
      return 0.4;
    case "Unknown":
      return 0.2;
    case "Proprietary-Paid":
    case "Restricted":
      return 0.0;
  }
}

/** Detect SPDX id (case-insensitive) → license; unknown → Unknown. */
export function classifyFromSpdx(spdxId: string | undefined | null): ProjectRagLicense {
  if (!spdxId) return "Unknown";
  const normalized = spdxId.trim().toUpperCase();
  // Map directly when an SPDX id matches one of our enum values.
  const knownSpdx: Record<string, ProjectRagLicense> = {
    "CC0-1.0": "CC0",
    CC0: "CC0",
    MIT: "MIT",
    "APACHE-2.0": "Apache-2.0",
    "BSD-2-CLAUSE": "BSD-2-Clause",
    "BSD-3-CLAUSE": "BSD-3-Clause",
    ISC: "ISC",
    "MPL-2.0": "MPL-2.0",
    "GPL-2.0": "GPL-2.0",
    "GPL-2.0-ONLY": "GPL-2.0",
    "GPL-2.0-OR-LATER": "GPL-2.0",
    "GPL-3.0": "GPL-3.0",
    "GPL-3.0-ONLY": "GPL-3.0",
    "GPL-3.0-OR-LATER": "GPL-3.0",
    "LGPL-2.1": "LGPL-2.1",
    "LGPL-3.0": "LGPL-3.0",
    "AGPL-3.0": "AGPL-3.0",
    "AGPL-3.0-ONLY": "AGPL-3.0",
    "AGPL-3.0-OR-LATER": "AGPL-3.0",
    "CC-BY-4.0": "CC-BY",
    "CC-BY-3.0": "CC-BY",
    "CC-BY-SA-4.0": "CC-BY-SA",
    "CC-BY-SA-3.0": "CC-BY-SA",
  };
  return knownSpdx[normalized] ?? "Unknown";
}
