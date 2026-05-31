import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { LlmClientLike } from "../../src/llm/client.js";
import {
  type MoodboardToSystemArgs,
  type MoodboardToSystemDeps,
  moodboardToSystemImpl,
  moodboardToSystemSchema,
} from "../../src/tools/layer1/moodboardToSystem.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

// ---------- Test fixtures (one tiny PNG byte-string on disk) ----------

// Minimal 4×4 red PNG — content doesn't matter; we never decode it.
// Bytes are an arbitrary PNG signature + filler; we only need fs.readFile to succeed.
const TINY_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x04, 0x08, 0x02, 0x00, 0x00, 0x00, 0x26, 0x93, 0x09,
  0x29, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

let TMPDIR: string;
let IMG_PATH: string;

beforeAll(async () => {
  TMPDIR = await fs.mkdtemp(path.join(os.tmpdir(), "moodboard-test-"));
  IMG_PATH = path.join(TMPDIR, "red.png");
  await fs.writeFile(IMG_PATH, TINY_PNG);
});

afterAll(async () => {
  try {
    await fs.rm(TMPDIR, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

// ---------- Helpers ----------

function genResultText(container: string): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: `Built.\n\n\`\`\`json\n${JSON.stringify({
          container,
          output: `${container}/out1`,
          created: [`${container}/glsl1`],
          errors: [],
          warnings: [],
        })}\n\`\`\``,
      },
    ],
  };
}

function makeStubs(over: Partial<MoodboardToSystemDeps> = {}): {
  deps: MoodboardToSystemDeps;
  calls: {
    audio: number;
    gen: number;
    flock: number;
    tunnel: number;
    field: number;
    post: Array<{ source_path: string; effects: string[] }>;
  };
} {
  const calls = {
    audio: 0,
    gen: 0,
    flock: 0,
    tunnel: 0,
    field: 0,
    post: [] as Array<{ source_path: string; effects: string[] }>,
  };
  const deps: MoodboardToSystemDeps = {
    createAudioReactive: vi.fn(async () => {
      calls.audio++;
      return genResultText("/project1/audio_reactive");
    }),
    createGenerativeArt: vi.fn(async () => {
      calls.gen++;
      return genResultText("/project1/generative_art");
    }),
    createParticleFlock: vi.fn(async () => {
      calls.flock++;
      return genResultText("/project1/particle_flock");
    }),
    createFeedbackTunnel: vi.fn(async () => {
      calls.tunnel++;
      return genResultText("/project1/feedback_tunnel");
    }),
    createGpuParticleField: vi.fn(async () => {
      calls.field++;
      return genResultText("/project1/gpu_particle_field");
    }),
    applyPostProcessing: vi.fn(async (_ctx, a) => {
      calls.post.push({ source_path: a.source_path, effects: [...a.effects] });
      return genResultText("/project1/post_fx");
    }),
    ...over,
  };
  return { deps, calls };
}

function fakeCtx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    logger: silentLogger,
    ...over,
  } as ToolContext;
}

function makeLlm(text: string): LlmClientLike {
  return {
    complete: vi.fn(async () => ({ text })),
    chatStream: vi.fn(async () => ({ role: "assistant", content: null })),
  } as unknown as LlmClientLike;
}

function parsePayload(result: CallToolResult): Record<string, unknown> {
  const text = result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  const fence = /```json\s*([\s\S]*?)\s*```/.exec(text);
  if (!fence?.[1]) throw new Error(`no JSON in result: ${text}`);
  return JSON.parse(fence[1]);
}

function args(over: Partial<MoodboardToSystemArgs> = {}): MoodboardToSystemArgs {
  return moodboardToSystemSchema.parse({ images: [IMG_PATH], ...over });
}

const VALID_PLAN_JSON = JSON.stringify({
  palette: ["#112233", "#445566", "#778899", "#aabbcc", "#ddeeff"],
  mood: "cinematic neon dusk",
  motion: "drift",
  texture: "smooth",
  generator: "generative_art",
  technique: "flow_field",
  evolution_speed: 0.7,
  post_fx: ["bloom", "color_grade"],
});

// ---------- Tests ----------

describe("moodboardToSystem — LLM path", () => {
  it("happy path: parses LLM JSON, builds picked generator, chains post-FX", async () => {
    const llm = makeLlm(VALID_PLAN_JSON);
    const { deps, calls } = makeStubs();
    const ctx = fakeCtx({ llm });
    const result = await moodboardToSystemImpl(ctx, args({ style: "cinematic" }), deps);
    expect(result.isError).toBeFalsy();
    const payload = parsePayload(result);
    expect(payload.source).toBe("llm");
    expect(payload.generator).toBe("generative_art");
    expect(calls.gen).toBe(1);
    expect(calls.post).toHaveLength(1);
    const post0 = calls.post[0];
    expect(post0).toBeDefined();
    expect(post0?.source_path).toBe("/project1/generative_art/out1");
    expect(post0?.effects).toEqual(["bloom", "color_grade"]);
    expect(payload.palette).toEqual(["#112233", "#445566", "#778899", "#aabbcc", "#ddeeff"]);
    expect(payload.systemPath).toBe("/project1/generative_art");
  });

  it("strips markdown ```json fences before parsing", async () => {
    const llm = makeLlm(`\`\`\`json\n${VALID_PLAN_JSON}\n\`\`\``);
    const { deps } = makeStubs();
    const ctx = fakeCtx({ llm });
    const result = await moodboardToSystemImpl(ctx, args(), deps);
    expect(parsePayload(result).source).toBe("llm");
  });

  it("garbage LLM output falls back to grammar with a warning", async () => {
    const llm = makeLlm("sorry I cannot help with that");
    const { deps, calls } = makeStubs();
    const ctx = fakeCtx({ llm });
    const result = await moodboardToSystemImpl(ctx, args({ style: "glitch" }), deps);
    const payload = parsePayload(result);
    expect(payload.source).toBe("llm-fallback-to-grammar");
    expect(payload.generator).toBe("feedback_tunnel"); // glitch → feedback_tunnel
    expect(calls.tunnel).toBe(1);
    expect((payload.warnings as string[]).length).toBeGreaterThan(0);
  });
});

describe("moodboardToSystem — grammar path", () => {
  it("preferLlm:false skips LLM entirely", async () => {
    const llm = makeLlm(VALID_PLAN_JSON);
    const { deps } = makeStubs();
    const ctx = fakeCtx({ llm });
    const result = await moodboardToSystemImpl(
      ctx,
      args({ preferLlm: false, style: "organic" }),
      deps,
    );
    expect(parsePayload(result).source).toBe("grammar");
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it("undefined ctx.llm uses grammar without throwing", async () => {
    const { deps } = makeStubs();
    const result = await moodboardToSystemImpl(fakeCtx(), args({ style: "minimal" }), deps);
    const payload = parsePayload(result);
    expect(payload.source).toBe("grammar");
    expect(payload.generator).toBe("generative_art");
  });

  it("returns the default neutral palette in grammar mode (no decoder bundled)", async () => {
    const { deps } = makeStubs();
    const result = await moodboardToSystemImpl(fakeCtx(), args({ preferLlm: false }), deps);
    const payload = parsePayload(result);
    expect(payload.palette).toEqual(["#0a0a0a", "#f2f2f2", "#ff5e3a", "#2a6cff", "#94f0c8"]);
  });
});

describe("moodboardToSystem — overrides + safety", () => {
  it("generator='feedback_tunnel' overrides LLM pick (palette still from LLM)", async () => {
    const llm = makeLlm(VALID_PLAN_JSON);
    const { deps, calls } = makeStubs();
    const ctx = fakeCtx({ llm });
    const result = await moodboardToSystemImpl(ctx, args({ generator: "feedback_tunnel" }), deps);
    expect(calls.tunnel).toBe(1);
    expect(calls.gen).toBe(0);
    const payload = parsePayload(result);
    expect(payload.generator).toBe("feedback_tunnel");
    expect((payload.palette as string[])[0]).toBe("#112233");
  });

  it("includePostFx:false leaves applyPostProcessing untouched", async () => {
    const llm = makeLlm(VALID_PLAN_JSON);
    const { deps, calls } = makeStubs();
    const ctx = fakeCtx({ llm });
    await moodboardToSystemImpl(ctx, args({ includePostFx: false }), deps);
    expect(calls.post).toHaveLength(0);
  });

  it("downstream isError surfaces as isError; post-FX skipped", async () => {
    const llm = makeLlm(VALID_PLAN_JSON);
    const { deps, calls } = makeStubs({
      createGenerativeArt: vi.fn(
        async (): Promise<CallToolResult> => ({
          isError: true,
          content: [{ type: "text", text: "boom" }],
        }),
      ),
    });
    const ctx = fakeCtx({ llm });
    const result = await moodboardToSystemImpl(ctx, args(), deps);
    expect(result.isError).toBe(true);
    expect(calls.post).toHaveLength(0);
  });

  it("rejects an oversize image with a friendly error (no LLM call)", async () => {
    const bigPath = path.join(TMPDIR, "big.png");
    await fs.writeFile(bigPath, Buffer.alloc(5 * 1024 * 1024 + 1, 0));
    const llm = makeLlm(VALID_PLAN_JSON);
    const { deps } = makeStubs();
    const ctx = fakeCtx({ llm });
    const result = await moodboardToSystemImpl(ctx, args({ images: [bigPath] }), deps);
    expect(result.isError).toBe(true);
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it("rejects unsupported image extensions", async () => {
    const ctx = fakeCtx({ llm: makeLlm(VALID_PLAN_JSON) });
    const { deps } = makeStubs();
    const result = await moodboardToSystemImpl(ctx, args({ images: ["notes.txt"] }), deps);
    expect(result.isError).toBe(true);
  });

  it("drops 'feedback_trail' (not a known post-fx) with a warning, applies the rest", async () => {
    const llm = makeLlm(
      JSON.stringify({
        ...JSON.parse(VALID_PLAN_JSON),
        post_fx: ["bloom", "feedback_trail", "chromatic_aberration"],
      }),
    );
    const { deps, calls } = makeStubs();
    const ctx = fakeCtx({ llm });
    const result = await moodboardToSystemImpl(ctx, args(), deps);
    const payload = parsePayload(result);
    expect(calls.post).toHaveLength(1);
    expect(calls.post[0]?.effects).toEqual(["bloom", "chromatic_aberration"]);
    expect((payload.warnings as string[]).some((w) => w.includes("feedback_trail"))).toBe(true);
  });
});

describe("moodboardToSystem — schema defaults", () => {
  it("provides sensible defaults for all optional fields", () => {
    const parsed = moodboardToSystemSchema.parse({ images: ["x.png"] });
    expect(parsed.parent_path).toBe("/project1");
    expect(parsed.style).toBe("auto");
    expect(parsed.intensity).toBe(0.6);
    expect(parsed.includePostFx).toBe(true);
    expect(parsed.generator).toBe("auto");
    expect(parsed.preferLlm).toBe(true);
  });

  it("schema rejects 0 images and >6 images", () => {
    expect(() => moodboardToSystemSchema.parse({ images: [] })).toThrow();
    expect(() =>
      moodboardToSystemSchema.parse({ images: ["a", "b", "c", "d", "e", "f", "g"] }),
    ).toThrow();
  });
});
