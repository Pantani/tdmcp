import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import type { KnowledgeBase } from "../../src/knowledge/index.js";
import type { RecipeLibrary } from "../../src/recipes/loader.js";
import { RecipeSchema } from "../../src/recipes/schema.js";
import type { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  type EvolveParametersArgs,
  evolveParametersImpl,
} from "../../src/tools/layer1/evolveParameters.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

const RECIPE = RecipeSchema.parse({
  id: "evo_test",
  name: "Evo Test",
  nodes: [
    { name: "src", type: "noiseTOP" },
    { name: "outTop", type: "levelTOP" },
  ],
  connections: [{ from: "src", to: "outTop" }],
});

const recipes = {
  get: (id: string) => (id === "evo_test" ? RECIPE : undefined),
  list: () => [
    { id: "evo_test", name: "Evo Test", description: "", tags: [], difficulty: "intermediate" },
  ],
} as unknown as RecipeLibrary;

interface FakeOptions {
  createNodeThrows?: boolean;
}

interface Fake {
  client: TouchDesignerClient;
  deleteNode: ReturnType<typeof vi.fn>;
  updateNodeParameters: ReturnType<typeof vi.fn>;
  createNode: ReturnType<typeof vi.fn>;
}

function makeFake(opts: FakeOptions = {}): Fake {
  let energy = 0;
  let counter = 0;
  const createNode = vi.fn(async (input: { parent_path: string; type: string; name?: string }) => {
    if (opts.createNodeThrows) throw new Error("bridge offline");
    const name = input.name ?? `${input.type.replace(/[^a-z0-9]/gi, "").toLowerCase()}${++counter}`;
    return { path: `${input.parent_path}/${name}`, type: input.type, name };
  });
  const updateNodeParameters = vi.fn(async (_path: string, params: Record<string, unknown>) => {
    if ("level" in params) energy = Number(params.level);
    return {};
  });
  const deleteNode = vi.fn(async () => ({ ok: true }));
  const executePythonScript = vi.fn(async (script: string) => {
    if (script.includes("tdmcp_perform_mode"))
      return { stdout: JSON.stringify({ perform: false }) };
    if (script.includes("info_chop")) {
      return { stdout: JSON.stringify({ info_chop: { channels: { energy }, warnings: [] } }) };
    }
    return { stdout: "" };
  });
  const client = {
    createNode,
    updateNodeParameters,
    deleteNode,
    executePythonScript,
    getPreview: vi.fn(async (path: string) => ({
      path,
      width: 4,
      height: 4,
      base64: Buffer.alloc(16, 128).toString("base64"),
      format: "png",
    })),
    getNetworkErrors: vi.fn(async (path: string) => ({ path, errors: [] })),
  } as unknown as TouchDesignerClient;
  return { client, deleteNode, updateNodeParameters, createNode };
}

function makeCtx(fake: Fake): ToolContext {
  return {
    client: fake.client,
    knowledge: {} as unknown as KnowledgeBase,
    recipes,
    logger: silentLogger,
  };
}

function baseArgs(over: Partial<EvolveParametersArgs> = {}): EvolveParametersArgs {
  return {
    genes: { "outTop.level": ["0.1", "0.5", "0.9"] },
    build_target: "evo_test",
    fitness: "audio_energy",
    fitness_target_path: "outTop",
    population: 4,
    generations: 3,
    elite_fraction: 0.3,
    crossover_rate: 0.5,
    mutation_rate: 0.2,
    frame_gap: 6,
    seed: 1234,
    parent_path: "/project1",
    ...over,
  };
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

function jsonOf(result: CallToolResult): Record<string, unknown> {
  const match = /```json\n([\s\S]*?)\n```/.exec(textOf(result));
  return match ? (JSON.parse(match[1] as string) as Record<string, unknown>) : {};
}

describe("evolveParametersImpl — validation", () => {
  it("rejects empty genes", async () => {
    const result = await evolveParametersImpl(makeCtx(makeFake()), baseArgs({ genes: {} }));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("genes` is empty");
  });

  it("rejects an unknown build_target and lists available ids", async () => {
    const result = await evolveParametersImpl(
      makeCtx(makeFake()),
      baseArgs({ build_target: "nope" }),
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("evo_test");
  });

  it("rejects population*generations over the hard cap without building", async () => {
    const fake = makeFake();
    const result = await evolveParametersImpl(
      makeCtx(fake),
      baseArgs({ population: 20, generations: 20 }),
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("hard cap");
    expect(fake.createNode).not.toHaveBeenCalled();
  });
});

describe("evolveParametersImpl — evolution loop", () => {
  it("decodes the genome into setParams calls and converges to the optimal value", async () => {
    const fake = makeFake();
    const result = await evolveParametersImpl(
      makeCtx(fake),
      baseArgs({ population: 6, generations: 5 }),
    );
    expect(result.isError).toBeFalsy();
    // Fitness == numeric level, so the winner must be the "0.9" gene.
    const data = jsonOf(result);
    expect((data.best_genome as Record<string, string>)["outTop.level"]).toBe("0.9");
    expect(data.best_fitness).toBe(0.9);
    // Genome decode routed through updateNodeParameters with the numeric level.
    const levels = fake.updateNodeParameters.mock.calls.map((c) => c[1]);
    expect(levels.some((p) => (p as { level?: number }).level === 0.9)).toBe(true);
  });

  it("deletes every candidate plus the scratch container, keeping only the winner", async () => {
    const fake = makeFake();
    await evolveParametersImpl(makeCtx(fake), baseArgs({ population: 4, generations: 3 }));
    // 4*3 candidates each deleted immediately, plus the scratch container.
    expect(fake.deleteNode).toHaveBeenCalledTimes(4 * 3 + 1);
  });

  it("is deterministic under a fixed seed", async () => {
    const a = jsonOf(await evolveParametersImpl(makeCtx(makeFake()), baseArgs()));
    const b = jsonOf(await evolveParametersImpl(makeCtx(makeFake()), baseArgs()));
    expect(a.best_genome).toEqual(b.best_genome);
    expect(a.best_fitness).toEqual(b.best_fitness);
  });

  it("scores an unresolved fitness_target_path as -Infinity with a warning, never throwing", async () => {
    const fake = makeFake();
    const result = await evolveParametersImpl(
      makeCtx(fake),
      baseArgs({ fitness_target_path: "does_not_exist", population: 3, generations: 2 }),
    );
    // Best is still defined (all -Infinity), so the winner is rebuilt — not an error.
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("did not resolve");
  });

  it("surfaces a mid-loop client failure as a friendly result, not an exception", async () => {
    const fake = makeFake({ createNodeThrows: true });
    const result = await evolveParametersImpl(makeCtx(fake), baseArgs());
    expect(result.isError).toBe(true);
  });
});
