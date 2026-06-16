/**
 * Creative RAG — pure cosine similarity over plain number vectors.
 *
 * No dependencies; dimension-agnostic. Returns 0 whenever either vector has zero
 * magnitude (or the lengths differ), so a malformed/empty embedding can never
 * produce a NaN score that poisons the ranking.
 */

/** Euclidean (L2) norm of a vector. */
export function norm(v: number[]): number {
  let sum = 0;
  for (let i = 0; i < v.length; i++) {
    const x = v[i] ?? 0;
    sum += x * x;
  }
  return Math.sqrt(sum);
}

/** Return a unit-length copy of `v`; a zero vector is returned unchanged. */
export function normalize(v: number[]): number[] {
  const n = norm(v);
  if (n === 0) {
    return v.slice();
  }
  return v.map((x) => x / n);
}

/**
 * Cosine similarity of `a` and `b`. Returns 0 when either norm is 0 or the
 * lengths differ, so the caller never has to guard against NaN.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
