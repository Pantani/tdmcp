// ---------------------------------------------------------------------------
// Pure-TS categorical genetic algorithm operators for `evolve_parameters`.
//
// One function per operator, each cyclomatic-complexity ≤ 10, no I/O and no TD
// dependency. Every operator is deterministic given a seeded RNG (mulberry32) —
// the caller passes the RNG so the harness never touches Math.random. All
// operators MAXIMISE fitness (higher = fitter). Method adopted from NEvo's
// categorical GA (arXiv 2607.02317, CC BY 4.0 — re-implemented, not integrated).
// ---------------------------------------------------------------------------

export type Gene = string;
export type Genome = Record<Gene, string>;
export interface Scored {
  genome: Genome;
  fitness: number;
}

export interface GaOptions {
  population: number;
  eliteCount: number;
  crossoverRate: number;
  mutationRate: number;
}

/** Deterministic mulberry32 PRNG; when `seed` is undefined it derives from the clock. */
export function makeRng(seed?: number): () => number {
  let a = (seed ?? Date.now()) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Picks one element from a non-empty array using the supplied RNG. */
function choice<T>(values: readonly T[], rng: () => number): T {
  const idx = Math.min(Math.floor(rng() * values.length), values.length - 1);
  return values[idx] as T;
}

/** Builds one genome by picking a single allowed value per gene. */
export function randomGenome(genes: Record<Gene, string[]>, rng: () => number): Genome {
  const genome: Genome = {};
  for (const [gene, values] of Object.entries(genes)) {
    genome[gene] = choice(values, rng);
  }
  return genome;
}

/** Builds an initial population of `size` random genomes. */
export function initPopulation(
  genes: Record<Gene, string[]>,
  size: number,
  rng: () => number,
): Genome[] {
  const out: Genome[] = [];
  for (let i = 0; i < size; i++) out.push(randomGenome(genes, rng));
  return out;
}

/** Returns the top `eliteCount` scored genomes by descending fitness (stable on ties). */
export function selectElite(scored: Scored[], eliteCount: number): Scored[] {
  const indexed = scored.map((s, i) => ({ s, i }));
  indexed.sort((a, b) => b.s.fitness - a.s.fitness || a.i - b.i);
  const n = Math.max(1, Math.min(eliteCount, scored.length));
  return indexed.slice(0, n).map((x) => x.s);
}

/** Single-point crossover over `keys`; with prob `1 - rate` it clones `a` verbatim. */
export function crossover(
  a: Genome,
  b: Genome,
  keys: Gene[],
  rng: () => number,
  rate: number,
): Genome {
  if (rng() >= rate || keys.length < 2) return { ...a };
  const point = 1 + Math.floor(rng() * (keys.length - 1));
  const child: Genome = {};
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (key === undefined) continue;
    const value = (i < point ? a : b)[key];
    if (value !== undefined) child[key] = value;
  }
  return child;
}

/** Per-gene mutation: with prob `rate` a gene is resampled from its allowed values. */
export function mutate(
  genome: Genome,
  genes: Record<Gene, string[]>,
  rng: () => number,
  rate: number,
): Genome {
  const child: Genome = { ...genome };
  for (const [gene, values] of Object.entries(genes)) {
    if (rng() < rate) child[gene] = choice(values, rng);
  }
  return child;
}

/**
 * μ+λ next generation: carry the elite genomes verbatim, then fill to `population`
 * by crossing two elite parents and mutating the child. Output length == population.
 */
export function nextGeneration(
  scored: Scored[],
  genes: Record<Gene, string[]>,
  opts: GaOptions,
  rng: () => number,
): Genome[] {
  const keys = Object.keys(genes);
  const elite = selectElite(scored, opts.eliteCount);
  const next: Genome[] = elite.map((e) => ({ ...e.genome }));
  while (next.length < opts.population && elite.length > 0) {
    const pa = choice(elite, rng).genome;
    const pb = choice(elite, rng).genome;
    const crossed = crossover(pa, pb, keys, rng, opts.crossoverRate);
    next.push(mutate(crossed, genes, rng, opts.mutationRate));
  }
  return next.slice(0, opts.population);
}
