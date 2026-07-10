import { describe, expect, it } from "vitest";
import {
  crossover,
  type GaOptions,
  type Genome,
  initPopulation,
  makeRng,
  mutate,
  nextGeneration,
  randomGenome,
  type Scored,
  selectElite,
} from "../../src/tools/layer1/geneticAlgorithm.js";

const GENES: Record<string, string[]> = {
  "a.x": ["0.1", "0.5", "0.9"],
  "b.y": ["red", "green", "blue"],
};

describe("makeRng", () => {
  it("is deterministic for a given seed", () => {
    const r1 = makeRng(42);
    const r2 = makeRng(42);
    const s1 = [r1(), r1(), r1(), r1()];
    const s2 = [r2(), r2(), r2(), r2()];
    expect(s1).toEqual(s2);
    // values are in [0, 1)
    for (const v of s1) expect(v).toBeGreaterThanOrEqual(0);
    for (const v of s1) expect(v).toBeLessThan(1);
  });

  it("differs across seeds", () => {
    expect(makeRng(1)()).not.toEqual(makeRng(2)());
  });
});

describe("randomGenome / initPopulation", () => {
  it("only emits allowed values and exact population length", () => {
    const rng = makeRng(7);
    const pop = initPopulation(GENES, 10, rng);
    expect(pop).toHaveLength(10);
    for (const genome of pop) {
      expect(Object.keys(genome).sort()).toEqual(["a.x", "b.y"]);
      expect(GENES["a.x"]).toContain(genome["a.x"]);
      expect(GENES["b.y"]).toContain(genome["b.y"]);
    }
  });

  it("is reproducible for a seed", () => {
    expect(randomGenome(GENES, makeRng(3))).toEqual(randomGenome(GENES, makeRng(3)));
  });
});

describe("selectElite", () => {
  it("returns the top-N by descending fitness, stable on ties", () => {
    const scored: Scored[] = [
      { genome: { g: "a" }, fitness: 1 },
      { genome: { g: "b" }, fitness: 3 },
      { genome: { g: "c" }, fitness: 3 },
      { genome: { g: "d" }, fitness: 2 },
    ];
    const elite = selectElite(scored, 2);
    expect(elite.map((e) => e.genome.g)).toEqual(["b", "c"]);
  });

  it("always keeps at least one", () => {
    expect(selectElite([{ genome: { g: "a" }, fitness: 0 }], 0)).toHaveLength(1);
  });
});

describe("crossover", () => {
  const keys = ["a.x", "b.y"];
  const a: Genome = { "a.x": "0.1", "b.y": "red" };
  const b: Genome = { "a.x": "0.9", "b.y": "blue" };

  it("clones `a` when rate is 0", () => {
    expect(crossover(a, b, keys, makeRng(1), 0)).toEqual(a);
  });

  it("recombines at a valid point when rate is 1", () => {
    const child = crossover(a, b, keys, makeRng(5), 1);
    // Single-point split: first key from a, remaining from b.
    expect(child["a.x"]).toBe("0.1");
    expect(child["b.y"]).toBe("blue");
  });
});

describe("mutate", () => {
  it("is identity when rate is 0", () => {
    const genome: Genome = { "a.x": "0.5", "b.y": "green" };
    expect(mutate(genome, GENES, makeRng(9), 0)).toEqual(genome);
  });

  it("resamples every gene from the allowed set when rate is 1", () => {
    const genome: Genome = { "a.x": "0.5", "b.y": "green" };
    const mutated = mutate(genome, GENES, makeRng(9), 1);
    expect(GENES["a.x"]).toContain(mutated["a.x"]);
    expect(GENES["b.y"]).toContain(mutated["b.y"]);
  });
});

describe("nextGeneration", () => {
  const opts: GaOptions = { population: 6, eliteCount: 2, crossoverRate: 0.5, mutationRate: 0.2 };
  const scored: Scored[] = [
    { genome: { "a.x": "0.9", "b.y": "red" }, fitness: 10 },
    { genome: { "a.x": "0.5", "b.y": "blue" }, fitness: 8 },
    { genome: { "a.x": "0.1", "b.y": "green" }, fitness: 1 },
  ];

  it("keeps the elite genomes verbatim and returns exactly `population`", () => {
    const next = nextGeneration(scored, GENES, opts, makeRng(11));
    expect(next).toHaveLength(6);
    // The two fittest genomes are carried at the front.
    expect(next[0]).toEqual(scored[0]?.genome);
    expect(next[1]).toEqual(scored[1]?.genome);
  });

  it("is deterministic for a seed", () => {
    expect(nextGeneration(scored, GENES, opts, makeRng(21))).toEqual(
      nextGeneration(scored, GENES, opts, makeRng(21)),
    );
  });
});
