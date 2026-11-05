import { join } from "node:path";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AceStepClient } from "../../src/ace-client/aceStepClient.js";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import type { AceToolContext } from "../../src/tools/layer3/generateMusic.js";
import { getMusicJobImpl } from "../../src/tools/layer3/getMusicJob.js";
import { submitMusicJobImpl } from "../../src/tools/layer3/submitMusicJob.js";
import { silentLogger } from "../../src/utils/logger.js";
import {
  ACE_BASE,
  aceOutputDir,
  failedRow,
  mockAce,
  runningRow,
  succeededRow,
  UNKNOWN_ROW,
} from "../helpers/aceMock.js";

const OUTPUT_DIR = aceOutputDir();

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

function makeClient(): AceStepClient {
  return new AceStepClient({ baseUrl: ACE_BASE, timeoutMs: 2000, outputDir: OUTPUT_DIR });
}

function structured(result: { structuredContent?: unknown }): Record<string, unknown> {
  return (result.structuredContent ?? {}) as Record<string, unknown>;
}

function textOf(result: { content: { type: string; text?: string }[] }): string {
  const t = result.content.find((c) => c.type === "text") as { text?: string } | undefined;
  return t?.text ?? "";
}

describe("submit_music_job", () => {
  it("returns the job id and submits the same body as generate_music", async () => {
    const { bodies, queries } = mockAce(server, []);
    const result = await submitMusicJobImpl(makeCtx(makeClient()), {
      prompt: "techno",
      audio_duration: 30,
    });
    expect(structured(result)).toEqual({ job_id: "task-1" });
    expect(textOf(result)).toContain("get_music_job");
    expect(bodies[0]).toMatchObject({ prompt: "techno", audio_duration: 30, audio_format: "wav" });
    expect(queries).toHaveLength(0);
  });

  it("disabled gate: no client -> friendly error, no network", async () => {
    const result = await submitMusicJobImpl(makeCtx(undefined), { prompt: "x" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("TDMCP_ACE_ENABLED=1");
  });

  it("invalid args (empty prompt) -> errorResult", async () => {
    const result = await submitMusicJobImpl(makeCtx(makeClient()), { prompt: "" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Invalid arguments");
  });
});

describe("get_music_job", () => {
  it("running: reports status + progress, with no wavPath key", async () => {
    mockAce(server, [runningRow(0.25, "diffusion")]);
    const result = await getMusicJobImpl(makeCtx(makeClient()), { job_id: "task-1" });
    expect(structured(result)).toEqual({ status: "running", progress: 0.25, stage: "diffusion" });
    expect(textOf(result)).toContain("running");
  });

  it("done: full fields, with the path of the downloaded file", async () => {
    mockAce(server, [succeededRow({ duration: 12, seed_value: "9" })]);
    const result = await getMusicJobImpl(makeCtx(makeClient()), { job_id: "task-1" });
    const wavPath = join(OUTPUT_DIR, "task-1.wav");
    expect(structured(result)).toEqual({ status: "done", wavPath, seconds: 12, seed: 9 });
    expect(textOf(result)).toContain(wavPath);
  });

  it("failed: status error carries upstream's message and is not a tool error", async () => {
    mockAce(server, [failedRow("boom")]);
    const result = await getMusicJobImpl(makeCtx(makeClient()), { job_id: "task-1" });
    expect(result.isError).toBeFalsy();
    expect(structured(result)).toEqual({ status: "error", error: "boom" });
  });

  it("unknown id -> friendly errorResult, no throw", async () => {
    mockAce(server, [UNKNOWN_ROW]);
    const result = await getMusicJobImpl(makeCtx(makeClient()), { job_id: "nope" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("does not know job nope");
  });

  it("disabled gate: no client -> friendly error, no network", async () => {
    const result = await getMusicJobImpl(makeCtx(undefined), { job_id: "x" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("TDMCP_ACE_ENABLED=1");
  });

  it("invalid args (empty job_id) -> errorResult", async () => {
    const result = await getMusicJobImpl(makeCtx(makeClient()), { job_id: "" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Invalid arguments");
  });
});
