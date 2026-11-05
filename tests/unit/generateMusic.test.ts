import { join } from "node:path";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AceStepClient } from "../../src/ace-client/aceStepClient.js";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { type AceToolContext, generateMusicImpl } from "../../src/tools/layer3/generateMusic.js";
import type { ToolExtra } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import {
  ACE_BASE,
  aceOutputDir,
  failedRow,
  mockAce,
  runningRow,
  succeededRow,
} from "../helpers/aceMock.js";

const OUTPUT_DIR = aceOutputDir();
const WAV_PATH = join(OUTPUT_DIR, "task-1.wav");

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function makeCtx(aceClient?: AceStepClient): AceToolContext {
  return {
    client: new TouchDesignerClient({ baseUrl: "http://127.0.0.1:9980", timeoutMs: 2000 }),
    knowledge: new KnowledgeBase(),
    recipes: new RecipeLibrary(),
    logger: silentLogger,
    aceClient,
  };
}

function makeClient(over: { rtf?: number; syncMaxSeconds?: number } = {}): AceStepClient {
  return new AceStepClient({
    baseUrl: ACE_BASE,
    timeoutMs: 2000,
    outputDir: OUTPUT_DIR,
    pollMs: 1,
    ...over,
  });
}

const OK_ROW = succeededRow({ duration: 30, seed_value: "42" });

function textOf(result: { content: { type: string }[] }): string | undefined {
  return (result.content.find((c) => c.type === "text") as { text: string } | undefined)?.text;
}

function structured(result: { structuredContent?: unknown }): Record<string, unknown> {
  return (result.structuredContent ?? {}) as Record<string, unknown>;
}

describe("generate_music", () => {
  it("happy path (sync): local wavPath/seconds/seed + mode:'sync'", async () => {
    mockAce(server, [runningRow(), OK_ROW]);
    const result = await generateMusicImpl(makeCtx(makeClient()), {
      prompt: "lofi hip hop, mellow",
    });
    expect(result.isError).toBeFalsy();
    expect(structured(result)).toMatchObject({
      mode: "sync",
      wavPath: WAV_PATH,
      seconds: 30,
      seed: 42,
    });
    expect(textOf(result)).toContain(WAV_PATH);
    expect(textOf(result)).toContain("seed 42");
  });

  it("reports no seed when the server gave none and none was requested", async () => {
    mockAce(server, [succeededRow({ duration: 30 })]);
    const result = await generateMusicImpl(makeCtx(makeClient()), { prompt: "drone" });
    expect(structured(result)).not.toHaveProperty("seed");
    expect(textOf(result)).not.toContain("seed");
  });

  it("forwards the caller's generation fields to /release_task", async () => {
    const { bodies } = mockAce(server, [OK_ROW]);
    await generateMusicImpl(makeCtx(makeClient()), {
      prompt: "techno",
      lyrics: "[verse] hi",
      audio_duration: 45,
      seed: 3,
      inference_steps: 12,
      guidance_scale: 6,
    });
    expect(bodies[0]).toEqual({
      prompt: "techno",
      lyrics: "[verse] hi",
      audio_duration: 45,
      inference_steps: 12,
      guidance_scale: 6,
      use_random_seed: false,
      seed: 3,
      batch_size: 1,
      audio_format: "wav",
    });
  });

  it("returns observed_rtf and tells the operator how to use it", async () => {
    mockAce(server, [runningRow(), OK_ROW]);
    const client = makeClient();
    const result = await generateMusicImpl(makeCtx(client), { prompt: "x", mode: "sync" });
    expect(structured(result).observed_rtf).toEqual(expect.any(Number));
    expect(textOf(result)).toContain("TDMCP_ACE_RTF=");
  });

  it("mode=job returns a job_id immediately, without polling", async () => {
    const { queries } = mockAce(server, [OK_ROW]);
    const result = await generateMusicImpl(makeCtx(makeClient()), { prompt: "x", mode: "job" });
    expect(structured(result)).toEqual({ mode: "job", job_id: "task-1" });
    expect(queries).toHaveLength(0);
    expect(textOf(result)).toContain("get_music_job");
    expect(textOf(result)).not.toContain("cancel");
  });

  it("auto hands off to a job when a calibrated estimate exceeds the sync limit", async () => {
    mockAce(server, [OK_ROW]);
    const result = await generateMusicImpl(makeCtx(makeClient({ rtf: 3, syncMaxSeconds: 60 })), {
      prompt: "x",
      audio_duration: 60,
    });
    expect(structured(result)).toEqual({ mode: "job", job_id: "task-1", estimated_seconds: 180 });
  });

  it("emits progress only when the client asked for it", async () => {
    mockAce(server, [runningRow(), OK_ROW]);
    const sendNotification = vi.fn(async () => {});
    const extra = {
      signal: new AbortController().signal,
      requestId: 1,
      sendNotification,
      _meta: { progressToken: "t" },
    } as unknown as ToolExtra;
    await generateMusicImpl(makeCtx(makeClient()), { prompt: "x" }, extra);
    expect(sendNotification).toHaveBeenCalled();
  });

  it("disabled gate: no client -> friendly error naming the server to start", async () => {
    const result = await generateMusicImpl(makeCtx(undefined), { prompt: "x" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("TDMCP_ACE_ENABLED=1");
    expect(textOf(result)).toContain("acestep-api");
  });

  it("job failure -> friendly errorResult, no throw", async () => {
    mockAce(server, [failedRow("CUDA out of memory")]);
    const result = await generateMusicImpl(makeCtx(makeClient()), { prompt: "x" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("CUDA out of memory");
  });

  it.each([
    ["empty prompt", { prompt: "" }],
    ["duration under upstream's 10 s minimum", { prompt: "x", audio_duration: 5 }],
    ["duration over upstream's 600 s maximum", { prompt: "x", audio_duration: 601 }],
    ["non-integer seed", { prompt: "x", seed: 1.5 }],
    ["negative seed (upstream's random sentinel)", { prompt: "x", seed: -1 }],
    ["zero steps", { prompt: "x", inference_steps: 0 }],
    ["unknown mode", { prompt: "x", mode: "later" }],
  ])("rejects %s with an errorResult and no network", async (_name, args) => {
    const result = await generateMusicImpl(makeCtx(makeClient()), args);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Invalid arguments");
  });
});
