/**
 * Words that describe almost any visual and so must not drive recipe matching.
 * "generative", for instance, is a tag on most recipes, so leaving it in makes
 * findByTags pick an unrelated recipe (e.g. "glowing generative plasma" → particle galaxy).
 */
const GENERIC_TERMS = new Set([
  "generative",
  "visual",
  "visuals",
  "glow",
  "glowing",
  "abstract",
  "field",
  "system",
  "animated",
  "evolving",
  "dynamic",
  "background",
  "colorful",
  "colourful",
  "bright",
  "beautiful",
]);

/** Splits a description into discriminating lowercase terms for recipe tag matching. */
export function significantTerms(description: string): string[] {
  return description
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 3 && !GENERIC_TERMS.has(t));
}
