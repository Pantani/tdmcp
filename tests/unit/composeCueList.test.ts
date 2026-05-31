import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { normalize, SetlistSchema } from "../../src/automation/setlistSchema.js";
import type { LlmClientLike } from "../../src/llm/client.js";
import { composeCueListImpl, composeCueListSchema } from "../../src/tools/layer1/composeCueList.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

function fakeCtx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    client: {
      executePythonScript: vi.fn(async () => ({
        stdout: JSON.stringify({
          comp: "/project1/cue_seq",
          beat: "/project1/cue_seq/beat",
          engine: "/project1/cue_seq/engine",
          steps: [],
          controls: ["Active", "Step", "Barsperstep"],
          warnings: [],
        }),
      })),
    },
    logger: silentLogger,
    ...over,
  } as unknown as ToolContext;
}

function parseResult(result: CallToolResult): {
  source: string;
  setlist: {
    scenes?: Array<{ id?: string; cue?: string; hold_beats?: number; morph_seconds?: number }>;
    bpm?: number;
    title?: string;
  };
  warnings: string[];
  applied?: { containerPath: string; cueCount: number };
} {
  const text = result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  const fence = /```json\s*([\s\S]*?)\s*```/.exec(text);
  if (!fence?.[1]) throw new Error(`no JSON in result: ${text}`);
  return JSON.parse(fence[1]);
}

function defaults(
  over: Partial<Record<string, unknown>> = {},
): Parameters<typeof composeCueListImpl>[1] {
  return composeCueListSchema.parse({ description: "build then drop", ...over });
}

describe("composeCueList — grammar", () => {
  it("parses a multi-clause show into scenes with correct holds/morphs", async () => {
    const ctx = fakeCtx();
    const args = defaults({
      description: "build 8 bars then drop at bar 8, breakdown 16 bars, drop again, outro",
      preferLlm: false,
    });
    const res = await composeCueListImpl(ctx, args);
    const out = parseResult(res);
    expect(out.source).toBe("grammar");
    const scenes = out.setlist.scenes ?? [];
    expect(scenes.length).toBe(5);
    expect(scenes.map((s) => s.id)).toEqual(["build", "drop", "breakdown", "drop-2", "outro"]);
    const drop = scenes.find((s) => s.id === "drop");
    expect(drop?.morph_seconds).toBe(0);
    const breakdown = scenes.find((s) => s.id === "breakdown");
    expect(breakdown?.hold_beats).toBe(64);
    expect(SetlistSchema.safeParse(out.setlist).success).toBe(true);
  });

  it("extracts bpm and parses a 6-clause techno line", async () => {
    const ctx = fakeCtx();
    const args = defaults({
      description: "128 bpm techno intro, build, drop, breakdown, drop, outro",
      preferLlm: false,
    });
    const res = await composeCueListImpl(ctx, args);
    const out = parseResult(res);
    expect(out.setlist.bpm).toBe(128);
    expect(out.setlist.scenes?.length).toBe(6);
  });

  it("applies morph + for-bars modifiers to a chorus clause", async () => {
    const ctx = fakeCtx();
    const args = defaults({
      description: "morph 4s into chorus for 16 bars",
      preferLlm: false,
    });
    const res = await composeCueListImpl(ctx, args);
    const out = parseResult(res);
    const scenes = out.setlist.scenes ?? [];
    expect(scenes.length).toBeGreaterThanOrEqual(1);
    const chorus = scenes.find((s) => s.id === "chorus");
    expect(chorus).toBeDefined();
    expect(chorus?.morph_seconds).toBe(4);
    expect(chorus?.hold_beats).toBe(64);
  });

  it("falls back to a stylistic default for garbage input", async () => {
    const ctx = fakeCtx();
    const args = defaults({
      description: "????",
      preferLlm: false,
      style: "techno",
    });
    const res = await composeCueListImpl(ctx, args);
    const out = parseResult(res);
    expect(out.setlist.scenes?.length).toBe(6);
    expect(out.warnings.some((w) => /style default/i.test(w))).toBe(true);
  });

  it("ignores ctx.llm when preferLlm=false (grammar path)", async () => {
    const llm = {
      chatStream: vi.fn(),
      complete: vi.fn(),
    } as unknown as LlmClientLike;
    const ctx = fakeCtx({ llm });
    const args = defaults({
      description: "intro then build then drop then outro",
      preferLlm: false,
    });
    const res = await composeCueListImpl(ctx, args);
    const out = parseResult(res);
    expect(out.source).toBe("grammar");
    expect(llm.complete).not.toHaveBeenCalled();
  });
});

describe("composeCueList — LLM path", () => {
  it("uses LLM when it returns valid JSON setlist", async () => {
    const llmJson = JSON.stringify({
      version: 1,
      bpm: 124,
      scenes: [
        { id: "intro", cue: "intro", hold_beats: 16, morph_seconds: 4 },
        { id: "build", cue: "build", hold_beats: 16, morph_seconds: 0 },
        { id: "drop", cue: "drop", hold_beats: 32, morph_seconds: 0 },
        { id: "outro", cue: "outro", hold_beats: 16, morph_seconds: 8 },
      ],
    });
    const llm: LlmClientLike = {
      chatStream: vi.fn(),
      complete: vi.fn(async () => ({ text: llmJson })),
    };
    const ctx = fakeCtx({ llm });
    const args = defaults({ description: "techno set, intro, build, drop, outro" });
    const res = await composeCueListImpl(ctx, args);
    const out = parseResult(res);
    expect(out.source).toBe("llm");
    expect(out.setlist.scenes?.length).toBe(4);
    expect(out.setlist.bpm).toBe(124);
    expect(llm.complete).toHaveBeenCalledOnce();
  });

  it("falls back to grammar when LLM returns invalid JSON", async () => {
    const llm: LlmClientLike = {
      chatStream: vi.fn(),
      complete: vi.fn(async () => ({ text: "sorry, here's a list: 1. build 2. drop" })),
    };
    const ctx = fakeCtx({ llm });
    const args = defaults({
      description: "build then drop then outro",
    });
    const res = await composeCueListImpl(ctx, args);
    const out = parseResult(res);
    expect(out.source).toBe("llm-fallback-to-grammar");
    expect(out.warnings.some((w) => /invalid JSON|grammar fallback/i.test(w))).toBe(true);
    expect((out.setlist.scenes ?? []).length).toBeGreaterThan(0);
  });

  it("falls back to grammar when LLM throws", async () => {
    const llm: LlmClientLike = {
      chatStream: vi.fn(),
      complete: vi.fn(async () => {
        throw new Error("network down");
      }),
    };
    const ctx = fakeCtx({ llm });
    const args = defaults({ description: "intro, build, drop, outro" });
    const res = await composeCueListImpl(ctx, args);
    const out = parseResult(res);
    expect(out.source).toBe("llm-fallback-to-grammar");
    expect(out.warnings.some((w) => /LLM call failed/i.test(w))).toBe(true);
  });
});

describe("composeCueList — apply path", () => {
  it("calls the cue sequencer with derived steps when apply=true", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        comp: "/project1/myrig",
        beat: "/project1/myrig/beat",
        engine: "/project1/myrig/engine",
        steps: [
          { cue: "build", bars: 4 },
          { cue: "drop", bars: 4 },
        ],
        controls: ["Active", "Step", "Barsperstep"],
        warnings: [],
      }),
    }));
    const ctx = {
      client: { executePythonScript: exec },
      logger: silentLogger,
    } as unknown as ToolContext;
    const args = defaults({
      description: "build then drop then outro then intro",
      preferLlm: false,
      apply: true,
      containerName: "myrig",
    });
    const res = await composeCueListImpl(ctx, args);
    const out = parseResult(res);
    expect(exec).toHaveBeenCalledOnce();
    expect(out.applied).toBeDefined();
    expect(out.applied?.containerPath).toBe("/project1/myrig");
    expect(out.applied?.cueCount).toBe(out.setlist.scenes?.length);
  });

  it("keeps the composed setlist when the bridge is down and adds a warning", async () => {
    const exec = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const ctx = {
      client: { executePythonScript: exec },
      logger: silentLogger,
    } as unknown as ToolContext;
    const args = defaults({
      description: "build then drop then outro then intro",
      preferLlm: false,
      apply: true,
    });
    const res = await composeCueListImpl(ctx, args);
    expect(res.isError).toBeUndefined();
    const out = parseResult(res);
    expect(out.applied).toBeUndefined();
    expect(out.warnings.some((w) => /apply skipped/i.test(w))).toBe(true);
  });
});

describe("composeCueList — round-trip via normalize", () => {
  it("preserves scene-id order through normalize()", async () => {
    const ctx = fakeCtx();
    const args = defaults({
      description: "intro, build, drop, breakdown, drop, outro",
      preferLlm: false,
    });
    const res = await composeCueListImpl(ctx, args);
    const out = parseResult(res);
    const canonical = normalize(out.setlist);
    const ids = canonical.scenes.map((s) => s.id);
    expect(ids).toEqual(out.setlist.scenes?.map((s) => s.id));
  });
});
