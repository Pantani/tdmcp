/**
 * Extract the TD family suffix from an operator type string.
 *
 * Examples:
 *   "noiseTOP"   → "TOP"
 *   "audioCHOP"  → "CHOP"
 *   "baseCOMP"   → "COMP"
 *   "unknown"    → "OTHER"
 *
 * Lifted from src/resources/sceneSummary.ts so the digest resource
 * (src/resources/graphDigest.ts) and the scene summary can share one
 * implementation.
 */
export function familyOf(type: string): string {
  // Known 4-letter families: CHOP, COMP
  // Known 3-letter families: TOP, SOP, DAT, MAT, POP
  const known4 = ["CHOP", "COMP"];
  const known3 = ["TOP", "SOP", "DAT", "MAT", "POP"];
  const upper = type.toUpperCase();
  for (const fam of known4) {
    if (upper.endsWith(fam)) return fam;
  }
  for (const fam of known3) {
    if (upper.endsWith(fam)) return fam;
  }
  return "OTHER";
}
