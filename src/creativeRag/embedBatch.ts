/** Split into fixed-size chunks preserving order. A non-positive / non-integer / NaN size ⇒ one chunk. */
export function chunk<T>(items: T[], size: number): T[][] {
  if (items.length === 0) {
    return [];
  }
  // Only a positive integer is a valid step. NaN or a fraction would otherwise
  // produce empty slices and silently drop items, so fall back to a single chunk.
  if (!Number.isInteger(size) || size <= 0) {
    return [items.slice()];
  }
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/** Batched embed: chunks inputs, calls embedOne per chunk, concatenates in order. */
export async function embedInBatches(
  inputs: string[],
  batchSize: number,
  embedOne: (chunk: string[]) => Promise<number[][]>,
): Promise<number[][]> {
  const out: number[][] = [];
  for (const part of chunk(inputs, batchSize)) {
    const vectors = await embedOne(part);
    for (const vector of vectors) {
      out.push(vector);
    }
  }
  return out;
}
