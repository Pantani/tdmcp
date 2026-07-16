import { afterEach, describe, expect, it, vi } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import type { OperatorSummary } from "../../src/knowledge/types.js";
import {
  type CompleteResult,
  type LlmClientLike,
  LlmResponseTooLargeError,
} from "../../src/llm/client.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import type { Recipe, RecipeSummary } from "../../src/recipes/schema.js";
import {
  PLAN_VISUAL_COMPLETION_MAX_BYTES,
  PLAN_VISUAL_LLM_MAX_TOKENS,
  PLAN_VISUAL_PROMPT_MAX_BYTES,
  PLAN_VISUAL_RESPONSE_MAX_BYTES,
  type PlanVisualCandidate,
  PlanVisualGroundedResultSchema,
  runGroundedPlanVisual,
} from "../../src/tools/layer1/planVisualGrounding.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

const FALLBACK: PlanVisualCandidate = {
  interpretation: "deterministic feedback visual",
  recommended_tool: "create_feedback_network",
  recipe_id: null,
  operators: [],
  steps: [{ tool: "create_feedback_network", goal: "Build a feedback visual." }],
  warnings: [],
};

const RECIPE: Recipe = {
  id: "feedback_recipe",
  name: "Feedback Recipe",
  description: "A feedback tunnel built from noise and feedback operators.",
  tags: ["feedback", "tunnel"],
  difficulty: "beginner",
  td_version_min: "2023",
  nodes: [
    { name: "noise1", type: "noiseTOP", parameters: {} },
    { name: "out1", type: "nullTOP", parameters: {} },
  ],
  connections: [],
  parameters: [],
  glsl_uniforms: [],
  controls: [],
  preview_description: "Feedback preview",
};

const OPERATORS: OperatorSummary[] = [
  {
    slug: "noise-top",
    name: "noiseTOP",
    displayName: "Noise TOP",
    category: "TOP",
    subcategory: "Generator",
    summary: "Generate procedural noise.",
    keywords: ["noise", "texture"],
  },
  {
    slug: "null-top",
    name: "nullTOP",
    displayName: "Null TOP",
    category: "TOP",
    subcategory: "Utility",
    summary: "Terminate a TOP chain.",
    keywords: ["output"],
  },
];

const VALID_CANDIDATE: PlanVisualCandidate = {
  interpretation: "A grounded feedback tunnel.",
  recommended_tool: "apply_recipe",
  recipe_id: "Feedback Recipe",
  operators: [
    { type: "noiseTOP", purpose: "Generate the source texture." },
    { type: "nullTOP", purpose: "Expose the final output." },
  ],
  steps: [
    { tool: "apply_recipe", goal: "Apply the validated feedback recipe." },
    { tool: "get_td_node_errors", goal: "Verify the resulting network." },
  ],
  warnings: [],
};

const NO_REFERENCE_CANDIDATE: PlanVisualCandidate = {
  interpretation: "A grounded feedback visual.",
  recommended_tool: "create_feedback_network",
  recipe_id: null,
  operators: [],
  steps: [
    { tool: "create_feedback_network", goal: "Build the feedback visual." },
    { tool: "get_td_node_errors", goal: "Verify the resulting network." },
  ],
  warnings: [],
};

function oversizedRecipeSummaries(): RecipeSummary[] {
  return Array.from(
    { length: 8 },
    (_, index): RecipeSummary => ({
      id: `feedback_${index}`,
      name: `Feedback ${index} ${"n!".repeat(50)}`,
      description: `feedback ${"d!".repeat(200)}`,
      tags: Array.from({ length: 12 }, (__, tag) => `feedback-${tag}-${"t!".repeat(40)}`),
      difficulty: "advanced",
    }),
  );
}

type CompleteMock = ReturnType<
  typeof vi.fn<(messages: unknown, options: unknown) => Promise<CompleteResult>>
>;

interface ContextOptions {
  complete?: CompleteMock | null;
  registry?: Record<string, unknown> | null;
  recipes?: RecipeSummary[];
  recipeGet?: (id: string) => Recipe | undefined;
  operatorExists?: (type: string) => boolean;
}

function editorContext() {
  return {
    project: { name: "show.toe", folder: null, save_version: 1, save_build: "2025.1" },
    touchdesigner: { version: "2025", build: "1" },
    perform_mode: false,
    ui_available: true,
    panes: [
      {
        type: "NETWORKEDITOR",
        active: true,
        name: "pane1",
        owner: "/project1/api_key=editorsecret",
      },
    ],
    active_network_editor: {
      pane: {
        type: "NETWORKEDITOR",
        name: "pane1",
        owner: "/project1/api_key=editorsecret",
      },
      owner: "/project1/api_key=editorsecret",
      current: "/project1/api_key=editorsecret/noise1",
      selected: ["/project1/api_key=editorsecret/noise1"],
      rollover_operator: null,
      rollover_parameter: null,
      viewport: { x: 0, y: 0, zoom: 1 },
    },
    warnings: [],
  };
}

function registry(): Record<string, unknown> {
  return {
    create_visual_system: { description: "Build a visual system.", enabled: true },
    create_audio_reactive: { description: "Build an audio-reactive system.", enabled: true },
    create_particle_system: { description: "Build a particle system.", enabled: true },
    create_feedback_network: { description: "Build a feedback network.", enabled: true },
    create_generative_art: { description: "Build generative art.", enabled: true },
    apply_recipe: { description: "Apply a registered recipe.", enabled: true },
    get_td_node_errors: { description: "Read network errors.", enabled: true },
    get_preview: { description: "Capture a preview.", enabled: true },
  };
}

function defaultComplete(): CompleteMock {
  return vi.fn().mockResolvedValue({ text: JSON.stringify(VALID_CANDIDATE) });
}

function completionPromptBlock(complete: CompleteMock, name: string): unknown {
  const messages = complete.mock.calls[0]?.[0] as Array<{ content?: unknown }> | undefined;
  const prompt = messages?.[0]?.content;
  if (typeof prompt !== "string") throw new Error("completion prompt missing");
  const open = `<UNTRUSTED_${name}>\n`;
  const close = `\n</UNTRUSTED_${name}>`;
  const start = prompt.indexOf(open);
  const end = prompt.indexOf(close, start + open.length);
  if (start < 0 || end < 0) throw new Error(`prompt block ${name} missing`);
  return JSON.parse(prompt.slice(start + open.length, end));
}

function makeContext(options: ContextOptions = {}) {
  const complete = options.complete === undefined ? defaultComplete() : options.complete;
  const getEditorContext = vi.fn().mockResolvedValue(editorContext());
  const getNetworkTopology = vi.fn().mockResolvedValue({
    nodes: [
      { path: "/project1/api_key=graphsecret", name: "noise1", type: "noiseTOP" },
      { path: "/project1/scene/out1", name: "out1", type: "nullTOP" },
    ],
    connections: [
      {
        source_path: "/project1/api_key=graphsecret",
        source_output: 0,
        target_path: "/project1/scene/out1",
        target_input: 0,
      },
    ],
  });
  const getNetworkErrors = vi.fn().mockResolvedValue({ errors: [] });
  const executePythonScript = vi.fn();
  const summaries = options.recipes ?? [
    {
      id: RECIPE.id,
      name: RECIPE.name,
      description: RECIPE.description,
      tags: RECIPE.tags,
      difficulty: RECIPE.difficulty,
    },
  ];
  const recipeGet =
    options.recipeGet ??
    ((id: string) =>
      id === RECIPE.id || id.toLowerCase() === RECIPE.name.toLowerCase() ? RECIPE : undefined);
  const known = new Set(OPERATORS.map((operator) => operator.name));
  const ctx = {
    client: {
      getEditorContext,
      getNetworkTopology,
      getNetworkErrors,
      executePythonScript,
    },
    recipes: { list: () => summaries, get: recipeGet },
    knowledge: {
      searchOperators: () => OPERATORS,
      operatorExists: options.operatorExists ?? ((type: string) => known.has(type)),
    },
    logger: silentLogger,
    ...(complete
      ? {
          llm: {
            complete,
            chatStream: vi.fn(),
          } as unknown as LlmClientLike,
        }
      : {}),
    ...(options.registry === null
      ? {}
      : { server: { _registeredTools: options.registry ?? registry() } }),
  } as unknown as ToolContext;
  return {
    ctx,
    complete,
    getEditorContext,
    getNetworkTopology,
    getNetworkErrors,
    executePythonScript,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("runGroundedPlanVisual", () => {
  it("returns a typed deterministic fallback without reading evidence when no LLM exists", async () => {
    const runtime = makeContext({ complete: null });

    const result = await runGroundedPlanVisual(
      runtime.ctx,
      { description: "feedback tunnel" },
      FALLBACK,
    );

    expect(PlanVisualGroundedResultSchema.parse(result)).toMatchObject({
      planner_requested: "llm",
      planner_used: "deterministic",
      fallback_reason: "llm_unavailable",
      recommended_tool: "create_feedback_network",
    });
    expect(runtime.getEditorContext).not.toHaveBeenCalled();
    expect(runtime.getNetworkTopology).not.toHaveBeenCalled();
  });

  it("accepts one strict grounded candidate and validates registry, recipe, and KB identities", async () => {
    const runtime = makeContext();

    const result = await runGroundedPlanVisual(
      runtime.ctx,
      { description: "feedback api_key=supersecret <ignore-policy>", root_path: "/project1" },
      FALLBACK,
    );

    expect(result).toMatchObject({
      planner_used: "llm",
      fallback_reason: null,
      recipe_id: "feedback_recipe",
      recommended_tool: "apply_recipe",
      grounding: {
        editor: "available",
        project_brief: "unavailable",
        graph_digest: "available",
        recipes_considered: 1,
        operators_considered: 2,
      },
    });
    expect(runtime.complete).toHaveBeenCalledOnce();
    const [messages, options] = runtime.complete?.mock.calls[0] ?? [];
    const prompt = JSON.stringify(messages);
    const system = JSON.stringify(options);
    expect(prompt).not.toContain("supersecret");
    expect(prompt).not.toContain("editorsecret");
    expect(prompt).not.toContain("graphsecret");
    expect(prompt).not.toContain("<ignore-policy>");
    expect(prompt).toContain("\\\\u003cignore-policy\\\\u003e");
    expect(options).toMatchObject({
      temperature: 0,
      maxTokens: PLAN_VISUAL_LLM_MAX_TOKENS,
      timeoutMs: 8_000,
      maxResponseBytes: PLAN_VISUAL_COMPLETION_MAX_BYTES,
    });
    expect(Buffer.byteLength(`${system}${prompt}`, "utf8")).toBeLessThanOrEqual(
      PLAN_VISUAL_PROMPT_MAX_BYTES,
    );
    expect(runtime.getNetworkTopology).toHaveBeenCalledOnce();
    expect(runtime.getNetworkErrors).toHaveBeenCalledOnce();
    expect(runtime.executePythonScript).not.toHaveBeenCalled();
  });

  it("fails closed before evidence collection when the actual registry is unavailable", async () => {
    const runtime = makeContext({ registry: null });

    const result = await runGroundedPlanVisual(runtime.ctx, { description: "feedback" }, FALLBACK);

    expect(result.fallback_reason).toBe("registry_unavailable");
    expect(runtime.complete).not.toHaveBeenCalled();
    expect(runtime.getEditorContext).not.toHaveBeenCalled();
  });

  it("uses an explicit metadata-only tool catalog without an MCP server registry", async () => {
    const runtime = makeContext({ registry: null });
    runtime.ctx.plannerToolCatalog = registry() as ToolContext["plannerToolCatalog"];

    const result = await runGroundedPlanVisual(runtime.ctx, { description: "feedback" }, FALLBACK);

    expect(result.planner_used).toBe("llm");
    expect(runtime.complete).toHaveBeenCalledOnce();
  });

  it("treats the explicit tool catalog as authoritative over SDK internals", async () => {
    const runtime = makeContext();
    runtime.ctx.plannerToolCatalog = {
      ...registry(),
      apply_recipe: { description: "Disabled recipe tool.", enabled: false },
    } as ToolContext["plannerToolCatalog"];

    const result = await runGroundedPlanVisual(runtime.ctx, { description: "feedback" }, FALLBACK);

    expect(result.fallback_reason).toBe("unknown_tool");
  });

  it.each([
    ["unknown_tool", { ...VALID_CANDIDATE, recommended_tool: "execute_python_script" }],
    ["unknown_recipe", { ...VALID_CANDIDATE, recipe_id: "invented_recipe" }],
    [
      "unknown_operator",
      {
        ...VALID_CANDIDATE,
        operators: [{ type: "inventedTOP", purpose: "A hallucinated operator." }],
      },
    ],
  ] as const)("rejects the whole candidate for %s", async (reason, candidate) => {
    const complete = vi.fn().mockResolvedValue({ text: JSON.stringify(candidate) });
    const runtime = makeContext({ complete });

    const result = await runGroundedPlanVisual(runtime.ctx, { description: "feedback" }, FALLBACK);

    expect(result).toMatchObject({
      planner_used: "deterministic",
      fallback_reason: reason,
      recommended_tool: FALLBACK.recommended_tool,
    });
    expect(complete).toHaveBeenCalledOnce();
  });

  it("rejects an SDK-disabled tool even when its private registry key still exists", async () => {
    const tools = registry();
    tools.apply_recipe = { description: "Disabled recipe tool.", enabled: false };
    const runtime = makeContext({ registry: tools });

    const result = await runGroundedPlanVisual(runtime.ctx, { description: "feedback" }, FALLBACK);

    expect(result.fallback_reason).toBe("unknown_tool");
  });

  it("rejects a globally valid recipe that was absent from the supplied evidence", async () => {
    const hiddenRecipe = { ...RECIPE, id: "hidden_recipe", name: "Hidden Recipe" };
    const complete = vi.fn().mockResolvedValue({
      text: JSON.stringify({ ...VALID_CANDIDATE, recipe_id: hiddenRecipe.id }),
    });
    const runtime = makeContext({
      complete,
      recipeGet: (id) => (id === hiddenRecipe.id ? hiddenRecipe : undefined),
    });

    const result = await runGroundedPlanVisual(runtime.ctx, { description: "feedback" }, FALLBACK);

    expect(result.fallback_reason).toBe("unknown_recipe");
  });

  it("rejects a globally valid operator that was absent from the supplied evidence", async () => {
    const complete = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        ...VALID_CANDIDATE,
        operators: [{ type: "levelTOP", purpose: "Adjust the level." }],
      }),
    });
    const runtime = makeContext({ complete, operatorExists: () => true });

    const result = await runGroundedPlanVisual(runtime.ctx, { description: "feedback" }, FALLBACK);

    expect(result.fallback_reason).toBe("unknown_operator");
  });

  it.each([
    ["markdown fence", `\`\`\`json\n${JSON.stringify(VALID_CANDIDATE)}\n\`\`\``],
    ["trailing object", `${JSON.stringify(VALID_CANDIDATE)} {}`],
    ["unknown field", JSON.stringify({ ...VALID_CANDIDATE, execute: true })],
    ["invalid JSON", "{not-json}"],
  ])("falls back on strict response violation: %s", async (_label, text) => {
    const complete = vi.fn().mockResolvedValue({ text });
    const runtime = makeContext({ complete });

    const result = await runGroundedPlanVisual(runtime.ctx, { description: "feedback" }, FALLBACK);

    expect(result.fallback_reason).toBe("response_invalid");
  });

  it("rejects an oversized response before parsing it", async () => {
    const complete = vi
      .fn()
      .mockResolvedValue({ text: "x".repeat(PLAN_VISUAL_RESPONSE_MAX_BYTES + 1) });
    const runtime = makeContext({ complete });

    const result = await runGroundedPlanVisual(runtime.ctx, { description: "feedback" }, FALLBACK);

    expect(result.fallback_reason).toBe("response_oversized");
  });

  it("maps the transport's typed oversized error to response_oversized", async () => {
    const complete = vi
      .fn()
      .mockRejectedValue(new LlmResponseTooLargeError(PLAN_VISUAL_COMPLETION_MAX_BYTES));
    const runtime = makeContext({ complete });

    const result = await runGroundedPlanVisual(runtime.ctx, { description: "feedback" }, FALLBACK);

    expect(result.fallback_reason).toBe("response_oversized");
    expect(complete).toHaveBeenCalledOnce();
  });

  it("bounds a pending completion with one abortable attempt", async () => {
    vi.useFakeTimers();
    const complete = vi.fn().mockImplementation(
      () =>
        new Promise<CompleteResult>(() => {
          // Deliberately unresolved; the helper deadline must settle the tool call.
        }),
    );
    const runtime = makeContext({ complete });
    const pending = runGroundedPlanVisual(
      runtime.ctx,
      { description: "feedback", llm_timeout_ms: 1_000 },
      FALLBACK,
    );
    for (let index = 0; index < 20 && complete.mock.calls.length === 0; index += 1) {
      await Promise.resolve();
    }
    expect(complete).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1_000);
    const result = await pending;

    expect(result.fallback_reason).toBe("llm_timeout");
    expect(complete).toHaveBeenCalledOnce();
    const options = complete.mock.calls[0]?.[1] as { signal?: AbortSignal } | undefined;
    expect(options?.signal?.aborted).toBe(true);
  });

  it("compacts oversized recipe evidence as valid JSON before completing", async () => {
    const hugeRecipes = oversizedRecipeSummaries();
    const complete = vi.fn().mockResolvedValue({ text: JSON.stringify(NO_REFERENCE_CANDIDATE) });
    const runtime = makeContext({ complete, recipes: hugeRecipes, recipeGet: () => undefined });

    const result = await runGroundedPlanVisual(runtime.ctx, { description: "feedback" }, FALLBACK);

    expect(result).toMatchObject({ planner_used: "llm", fallback_reason: null });
    expect(complete).toHaveBeenCalledOnce();
    const recipeBlock = completionPromptBlock(complete, "RECIPES_JSON") as {
      summaries: RecipeSummary[];
    };
    expect(recipeBlock.summaries.length).toBeGreaterThan(0);
    expect(recipeBlock.summaries.length).toBeLessThan(hugeRecipes.length);
    expect(recipeBlock.summaries[0]?.description.length).toBeLessThanOrEqual(160);
    expect(recipeBlock.summaries[0]?.tags.length).toBeLessThanOrEqual(6);
    expect(recipeBlock.summaries).toHaveLength(result.grounding.recipes_considered);
    expect(JSON.stringify(result)).not.toContain("dddddddddddddddddddd");
  });

  it("rejects a valid recipe removed from the compacted prompt subset", async () => {
    const hugeRecipes = oversizedRecipeSummaries();
    const hidden = hugeRecipes.at(-1);
    if (!hidden) throw new Error("hidden recipe fixture missing");
    const hiddenRecipe: Recipe = {
      ...RECIPE,
      id: hidden.id,
      name: hidden.name,
      description: hidden.description,
      tags: hidden.tags,
      difficulty: hidden.difficulty,
    };
    const complete = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        ...NO_REFERENCE_CANDIDATE,
        recommended_tool: "apply_recipe",
        recipe_id: hidden.id,
        steps: [{ tool: "apply_recipe", goal: "Apply the hidden recipe." }],
      }),
    });
    const runtime = makeContext({
      complete,
      recipes: hugeRecipes,
      recipeGet: (id) => (id === hidden.id ? hiddenRecipe : undefined),
    });

    const result = await runGroundedPlanVisual(runtime.ctx, { description: "feedback" }, FALLBACK);
    const recipeBlock = completionPromptBlock(complete, "RECIPES_JSON") as {
      summaries: RecipeSummary[];
    };

    expect(recipeBlock.summaries.map((recipe) => recipe.id)).not.toContain(hidden.id);
    expect(result.fallback_reason).toBe("unknown_recipe");
  });

  it("reaches completion with the real recipe and operator catalogs", async () => {
    const complete = vi.fn().mockResolvedValue({ text: JSON.stringify(NO_REFERENCE_CANDIDATE) });
    const runtime = makeContext({ complete });
    const ctx = {
      ...runtime.ctx,
      recipes: new RecipeLibrary(),
      knowledge: new KnowledgeBase({ logger: silentLogger }),
    } as ToolContext;

    const result = await runGroundedPlanVisual(ctx, { description: "feedback tunnel" }, FALLBACK);

    expect(result).toMatchObject({ planner_used: "llm", fallback_reason: null });
    expect(complete).toHaveBeenCalledOnce();
    const recipeBlock = completionPromptBlock(complete, "RECIPES_JSON") as {
      summaries: RecipeSummary[];
    };
    expect(recipeBlock.summaries).toHaveLength(result.grounding.recipes_considered);
    expect(result.grounding.recipes_considered).toBeGreaterThan(0);
  });

  it("treats external cancellation as a typed timeout without a second completion", async () => {
    const controller = new AbortController();
    const complete = vi.fn().mockImplementation(
      (_messages, options: { signal?: AbortSignal }) =>
        new Promise<CompleteResult>((_resolve, reject) => {
          options.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("cancelled", "AbortError")),
            { once: true },
          );
        }),
    );
    const runtime = makeContext({ complete });
    const pending = runGroundedPlanVisual(runtime.ctx, { description: "feedback" }, FALLBACK, {
      signal: controller.signal,
    });
    for (let index = 0; index < 20 && complete.mock.calls.length === 0; index += 1) {
      await Promise.resolve();
    }
    controller.abort();

    const result = await pending;

    expect(result.fallback_reason).toBe("llm_timeout");
    expect(complete).toHaveBeenCalledOnce();
  });
});
