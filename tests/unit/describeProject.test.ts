import { describe, expect, it } from "vitest";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import {
  describeProjectImpl,
  describeProjectOutputSchema,
  describeProjectSchema,
} from "../../src/tools/layer1/describeProject.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

function makeCtx(): ToolContext {
  return {
    recipes: new RecipeLibrary(),
    logger: silentLogger,
  } as unknown as ToolContext;
}

function textOf(ctx: ToolContext, description: string): string {
  const result = describeProjectImpl(ctx, { description });
  if (result instanceof Promise) throw new Error("deterministic planner must stay synchronous");
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

describe("describeProjectImpl (plan_visual)", () => {
  it("keeps the legacy deterministic path synchronous and structured", () => {
    const llm = { complete: async () => ({ text: "must not run" }) };
    const result = describeProjectImpl({ ...makeCtx(), llm } as unknown as ToolContext, {
      description: "feedback trail",
    });
    expect(result).not.toBeInstanceOf(Promise);
    if (result instanceof Promise) throw new Error("unexpected promise");
    expect(describeProjectOutputSchema.parse(result.structuredContent)).toMatchObject({
      planner_requested: "deterministic",
      planner_used: "deterministic",
      recommended_tool: "create_feedback_network",
      fallback_reason: null,
    });
  });

  it("requires explicit llm opt-in and falls back when no backend is configured", async () => {
    const result = await describeProjectImpl(makeCtx(), {
      description: "atmospheric projection",
      planner: "llm",
    });
    expect(describeProjectOutputSchema.parse(result.structuredContent)).toMatchObject({
      planner_requested: "llm",
      planner_used: "deterministic",
      fallback_reason: "llm_unavailable",
      recommended_tool: "create_visual_system",
    });
  });

  it("bounds and defaults the additive planner inputs", () => {
    expect(describeProjectSchema.parse({ description: "x" })).toMatchObject({
      planner: "deterministic",
      llm_timeout_ms: 8_000,
    });
    expect(() =>
      describeProjectSchema.parse({ description: "x", planner: "llm", root_path: "relative" }),
    ).toThrow();
  });

  it("routes audio-related descriptions to create_audio_reactive", () => {
    expect(textOf(makeCtx(), "a spectrum visual reacting to music beats")).toContain(
      "create_audio_reactive",
    );
    expect(textOf(makeCtx(), "audio frequency visualizer")).toContain("create_audio_reactive");
  });

  it("routes particle-related descriptions to create_particle_system", () => {
    expect(textOf(makeCtx(), "a galaxy of sparkling particles")).toContain(
      "create_particle_system",
    );
    expect(textOf(makeCtx(), "swarm emitter with slow gravity")).toContain(
      "create_particle_system",
    );
  });

  it("routes reaction-diffusion descriptions to create_generative_art with the reaction_diffusion recipe", () => {
    const text = textOf(makeCtx(), "Gray-Scott reaction diffusion simulation");
    expect(text).toContain("create_generative_art");
    expect(text).toContain("reaction_diffusion");
  });

  it("routes feedback/tunnel descriptions to create_feedback_network", () => {
    expect(textOf(makeCtx(), "a feedback tunnel echo trail")).toContain("create_feedback_network");
    expect(textOf(makeCtx(), "kaleidoscope feedback loop")).toContain("create_feedback_network");
  });

  it("falls back to create_visual_system for unrecognized descriptions", () => {
    expect(textOf(makeCtx(), "something atmospheric and dreamy")).toContain("create_visual_system");
  });

  it("always includes the original description in the plan output", () => {
    const text = textOf(makeCtx(), "plasma noise vortex field");
    expect(text).toContain("plasma noise vortex field");
  });

  it("includes a call-to-action mentioning get_td_node_errors and get_preview", () => {
    const text = textOf(makeCtx(), "any description");
    expect(text).toContain("get_td_node_errors");
    expect(text).toContain("get_preview");
  });
});
