import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import {
  createAudioGlslUniformsImpl,
  createAudioGlslUniformsSchema,
} from "../../src/tools/layer2/createAudioGlslUniforms.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeCtx(exec: ReturnType<typeof vi.fn>): ToolContext {
  return {
    client: { executePythonScript: exec },
    logger: silentLogger,
  } as unknown as ToolContext;
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

function makeExecResult(
  overrides: Partial<{
    target_glsl_top: string;
    source_chop: string;
    slots_bound: Array<{ slot: number; uniform: string; component: string; expression: string }>;
    warnings: string[];
    error: string;
  }> = {},
) {
  const report = JSON.stringify({
    target_glsl_top: "/project1/glsl1",
    source_chop: "/project1/audio",
    slots_bound: [],
    warnings: [],
    ...overrides,
  });
  return { stdout: report };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createAudioGlslUniformsImpl", () => {
  it("happy path — single binding, auto slot=0", async () => {
    const slotBound = {
      slot: 0,
      uniform: "uBass",
      component: "x",
      expression: "op('/project1/audio')['low']",
    };
    const exec = vi.fn().mockResolvedValue(makeExecResult({ slots_bound: [slotBound] }));
    const ctx = fakeCtx(exec);

    const args = createAudioGlslUniformsSchema.parse({
      target_glsl_path: "/project1/glsl1",
      source_chop_path: "/project1/audio",
      bindings: [{ chan: "low", uniform: "uBass" }],
    });

    const result = await createAudioGlslUniformsImpl(ctx, args);

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("Bound 1 uniform slot(s)");
    expect(text).toContain("/project1/glsl1");
    expect(text).toContain("uBass");
    expect(text).toContain("'low'");
    expect(text).toContain("slot");
  });

  it("multi-component on same slot — 3 bindings share uniform uFreqs, all land on slot 0", async () => {
    const slots_bound = [
      { slot: 0, uniform: "uFreqs", component: "x", expression: "op('/project1/audio')['low']" },
      { slot: 0, uniform: "uFreqs", component: "y", expression: "op('/project1/audio')['mid']" },
      { slot: 0, uniform: "uFreqs", component: "z", expression: "op('/project1/audio')['high']" },
    ];
    const exec = vi.fn().mockResolvedValue(makeExecResult({ slots_bound }));
    const ctx = fakeCtx(exec);

    const args = createAudioGlslUniformsSchema.parse({
      target_glsl_path: "/project1/glsl1",
      source_chop_path: "/project1/audio",
      bindings: [
        { chan: "low", uniform: "uFreqs", component: "x" },
        { chan: "mid", uniform: "uFreqs", component: "y" },
        { chan: "high", uniform: "uFreqs", component: "z" },
      ],
    });

    const result = await createAudioGlslUniformsImpl(ctx, args);

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("Bound 3 uniform slot(s)");
    // All three share slot 0
    const parsed = JSON.parse(text.match(/```json\n([\s\S]+?)\n```/)?.[1] ?? "{}");
    const bound: typeof slots_bound = parsed.slots_bound;
    expect(bound).toHaveLength(3);
    expect(bound.every((s) => s.slot === 0)).toBe(true);
    expect(bound.every((s) => s.uniform === "uFreqs")).toBe(true);
  });

  it("multiple uniforms auto-slot — 2 distinct uniforms get slots 0 and 1", async () => {
    const slots_bound = [
      { slot: 0, uniform: "uBass", component: "x", expression: "op('/a')['low']" },
      { slot: 1, uniform: "uMid", component: "x", expression: "op('/a')['mid']" },
    ];
    const exec = vi.fn().mockResolvedValue(makeExecResult({ source_chop: "/a", slots_bound }));
    const ctx = fakeCtx(exec);

    const args = createAudioGlslUniformsSchema.parse({
      target_glsl_path: "/project1/glsl1",
      source_chop_path: "/a",
      bindings: [
        { chan: "low", uniform: "uBass" },
        { chan: "mid", uniform: "uMid" },
      ],
    });

    const result = await createAudioGlslUniformsImpl(ctx, args);

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    const parsed = JSON.parse(text.match(/```json\n([\s\S]+?)\n```/)?.[1] ?? "{}");
    const bound: typeof slots_bound = parsed.slots_bound;
    expect(bound[0]?.slot).toBe(0);
    expect(bound[0]?.uniform).toBe("uBass");
    expect(bound[1]?.slot).toBe(1);
    expect(bound[1]?.uniform).toBe("uMid");
  });

  it("explicit slot with expand_capacity=true — slot 5 respected, numBlocks grown", async () => {
    const slots_bound = [
      { slot: 5, uniform: "uRms", component: "x", expression: "op('/project1/audio')['rms']" },
    ];
    const exec = vi.fn().mockResolvedValue(makeExecResult({ slots_bound }));
    const ctx = fakeCtx(exec);

    const args = createAudioGlslUniformsSchema.parse({
      target_glsl_path: "/project1/glsl1",
      source_chop_path: "/project1/audio",
      bindings: [{ chan: "rms", uniform: "uRms", slot: 5 }],
      expand_capacity: true,
    });

    const result = await createAudioGlslUniformsImpl(ctx, args);

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    const parsed = JSON.parse(text.match(/```json\n([\s\S]+?)\n```/)?.[1] ?? "{}");
    expect(parsed.slots_bound[0]?.slot).toBe(5);
    // Verify the b64-embedded payload carries expand=true
    const scriptArg: string = exec.mock.calls[0]?.[0] ?? "";
    const b64 = /b64decode\("([^"]+)"\)/.exec(scriptArg)?.[1];
    expect(b64).toBeDefined();
    const p = JSON.parse(Buffer.from(b64 ?? "", "base64").toString("utf8")) as { expand: boolean };
    expect(p.expand).toBe(true);
  });

  it("slot out of range + expand=false — returns isError with numBlocks message", async () => {
    const exec = vi
      .fn()
      .mockResolvedValue(makeExecResult({ error: "slot 10 exceeds numBlocks=4" }));
    const ctx = fakeCtx(exec);

    const args = createAudioGlslUniformsSchema.parse({
      target_glsl_path: "/project1/glsl1",
      source_chop_path: "/project1/audio",
      bindings: [{ chan: "low", uniform: "uBass", slot: 10 }],
      expand_capacity: false,
    });

    const result = await createAudioGlslUniformsImpl(ctx, args);

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("numBlocks");
    expect(text).toContain("slot 10");
  });

  it("missing source channel — warning surfaces in the result", async () => {
    const slots_bound = [
      { slot: 0, uniform: "uGhost", component: "x", expression: "op('/project1/audio')['ghost']" },
    ];
    const exec = vi.fn().mockResolvedValue(
      makeExecResult({
        slots_bound,
        warnings: ["channel 'ghost' not in /project1/audio; uniform will read 0"],
      }),
    );
    const ctx = fakeCtx(exec);

    const args = createAudioGlslUniformsSchema.parse({
      target_glsl_path: "/project1/glsl1",
      source_chop_path: "/project1/audio",
      bindings: [{ chan: "ghost", uniform: "uGhost" }],
    });

    const result = await createAudioGlslUniformsImpl(ctx, args);

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("ghost");
    expect(text).toContain("uniform will read 0");
  });

  it("slot/uniform conflict — isError with conflict message", async () => {
    const exec = vi.fn().mockResolvedValue(
      makeExecResult({
        error: "slot 0 already bound to uniform 'uBass', can't also bind 'uMid'",
      }),
    );
    const ctx = fakeCtx(exec);

    const args = createAudioGlslUniformsSchema.parse({
      target_glsl_path: "/project1/glsl1",
      source_chop_path: "/project1/audio",
      bindings: [
        { chan: "low", uniform: "uBass", slot: 0 },
        { chan: "mid", uniform: "uMid", slot: 0 },
      ],
    });

    const result = await createAudioGlslUniformsImpl(ctx, args);

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("slot 0");
    expect(text).toContain("uBass");
    expect(text).toContain("uMid");
  });
});
