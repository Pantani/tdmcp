/** Split into fixed-size chunks preserving order. size<=0 ⇒ one chunk. */
export function chunk<T>(items: T[], size: number): T[][] {
  if (items.length === 0) {
    return [];
  }
  if (size <= 0) {
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
