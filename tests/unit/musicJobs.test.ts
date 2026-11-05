import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AceStepClient } from "../../src/ace-client/aceStepClient.js";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { cancelMusicJobImpl } from "../../src/tools/layer3/cancelMusicJob.js";
import { type AceToolContext, generateMusicImpl } from "../../src/tools/layer3/generateMusic.js";
import { getMusicJobImpl } from "../../src/tools/layer3/getMusicJob.js";
import { submitMusicJobImpl } from "../../src/tools/layer3/submitMusicJob.js";
import { silentLogger } from "../../src/utils/logger.js";

const ACE_BASE = "http://127.0.0.1:8000";
const OUTPUT_DIR = "/out/ace-output";

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

const CHECKPOINT_PATH = "/models/ace-step";

function makeClient(mode: "wrapper" | "native" = "wrapper"): AceStepClient {
  return new AceStepClient({
    baseUrl: ACE_BASE,
    timeoutMs: 2000,
    defaultSteps: 27,
    outputDir: OUTPUT_DIR,
    checkpointPath: CHECKPOINT_PATH,
    mode,
  });
}

function structured(result: { structuredContent?: unknown }): Record<string, unknown> {
  return (result.structuredContent ?? {}) as Record<string, unknown>;
}

function textOf(result: { content: { type: string; text?: string }[] }): string {
  const t = result.content.find((c) => c.type === "text") as { text?: string } | undefined;
  return t?.text ?? "";
}

describe("submit_music_job", () => {
  it("happy path: returns job_id and reuses the sync generate body (defaults injected)", async () => {
    const bodies: Record<string, unknown>[] = [];
    server.use(
      http.post(`${ACE_BASE}/jobs`, async ({ request }) => {
        bodies.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({ job_id: "abc" });
      }),
    );
    const result = await submitMusicJobImpl(makeCtx(makeClient()), { prompt: "techno" });
    expect(result.isError).toBeFalsy();
    expect(structured(result).job_id).toBe("abc");
    const body = bodies[0] ?? {};
    expect(body.infer_step).toBe(27);
    expect(body.guidance_scale).toBe(15.0);
    expect(body.save_path).toBe(OUTPUT_DIR);
  });

  it("disabled gate: no client -> friendly error, no network", async () => {
    const result = await submitMusicJobImpl(makeCtx(undefined), { prompt: "x" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("TDMCP_ACE_ENABLED=1");
  });

  it("native mode -> not supported, no network", async () => {
    const result = await submitMusicJobImpl(makeCtx(makeClient("native")), { prompt: "x" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("not supported in native ACE mode");
  });

  it("invalid args (empty prompt) -> errorResult", async () => {
    const result = await submitMusicJobImpl(makeCtx(makeClient()), { prompt: "" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Invalid arguments");
  });
});

describe("get_music_job", () => {
  it("running: status only, no wavPath key", async () => {
    server.use(
      http.get(`${ACE_BASE}/jobs/abc`, () =>
        HttpResponse.json({
          status: "running",
          wavPath: null,
          seconds: null,
          seed: null,
          error: null,
        }),
      ),
    );
    const result = await getMusicJobImpl(makeCtx(makeClient()), { job_id: "abc" });
    expect(result.isError).toBeFalsy();
    expect(structured(result)).toEqual({ status: "running" });
  });

  it("done: full fields deep-equal, summary carries the path", async () => {
    server.use(
      http.get(`${ACE_BASE}/jobs/abc`, () =>
        HttpResponse.json({ status: "done", wavPath: "/out/x.wav", seconds: 30, seed: 42 }),
      ),
    );
    const result = await getMusicJobImpl(makeCtx(makeClient()), { job_id: "abc" });
    expect(structured(result)).toEqual({
      status: "done",
      wavPath: "/out/x.wav",
      seconds: 30,
      seed: 42,
    });
    expect(textOf(result)).toContain("/out/x.wav");
  });

  it("unknown id (404) -> friendly errorResult, no throw", async () => {
    server.use(
      http.get(`${ACE_BASE}/jobs/nope`, () =>
        HttpResponse.json({ error: "Unknown job nope" }, { status: 404 }),
      ),
    );
    const result = await getMusicJobImpl(makeCtx(makeClient()), { job_id: "nope" });
    expect(result.isError).toBe(true);
  });

  it("native mode -> not supported, no network", async () => {
    const result = await getMusicJobImpl(makeCtx(makeClient("native")), { job_id: "abc" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("not supported in native ACE mode");
  });

  it("disabled gate: no client -> friendly error, no network", async () => {
    const result = await getMusicJobImpl(makeCtx(undefined), { job_id: "abc" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("TDMCP_ACE_ENABLED=1");
  });

  it("invalid args (empty job_id) -> errorResult", async () => {
    const result = await getMusicJobImpl(makeCtx(makeClient()), { job_id: "" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Invalid arguments");
  });
});

describe("cancel_music_job", () => {
  it("success -> cancelled true + status", async () => {
    server.use(
      http.post(`${ACE_BASE}/jobs/abc/cancel`, () =>
        HttpResponse.json({ cancelled: true, status: "cancelled" }),
      ),
    );
    const result = await cancelMusicJobImpl(makeCtx(makeClient()), { job_id: "abc" });
    expect(result.isError).toBeFalsy();
    expect(structured(result)).toEqual({ cancelled: true, status: "cancelled" });
    expect(textOf(result)).toContain("Cancelled job abc");
  });

  it("non-cancellable -> summary says not cancellable", async () => {
    server.use(
      http.post(`${ACE_BASE}/jobs/abc/cancel`, () =>
        HttpResponse.json({ cancelled: false, status: "done" }),
      ),
    );
    const result = await cancelMusicJobImpl(makeCtx(makeClient()), { job_id: "abc" });
    expect(structured(result)).toEqual({ cancelled: false, status: "done" });
    expect(textOf(result)).toContain("not cancellable");
  });

  it("native mode -> not supported, no network", async () => {
    const result = await cancelMusicJobImpl(makeCtx(makeClient("native")), { job_id: "abc" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("not supported in native ACE mode");
  });

  it("disabled gate: no client -> friendly error, no network", async () => {
    const result = await cancelMusicJobImpl(makeCtx(undefined), { job_id: "abc" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("TDMCP_ACE_ENABLED=1");
  });
});

describe("native generate mapping (F3)", () => {
  it("posts a COMPLETE ACEStepInput and adapts ACEStepOutput to GenerateResult", async () => {
    const bodies: Record<string, unknown>[] = [];
    server.use(
      http.post(`${ACE_BASE}/generate`, async ({ request }) => {
        bodies.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({ status: "ok", output_path: "/out/n.wav", message: "done" });
      }),
    );
    const result = await generateMusicImpl(makeCtx(makeClient("native")), {
      prompt: "ambient",
      audio_duration: 45,
      manual_seeds: 7,
    });
    expect(result.isError).toBeFalsy();
    // P2: the payload gained the `mode` discriminant (+ an optional observed_rtf);
    // the native POST /generate path itself is unchanged.
    expect(structured(result)).toMatchObject({
      mode: "sync",
      wavPath: "/out/n.wav",
      seconds: 45,
      seed: 7,
    });
    const body = bodies[0] ?? {};
    // FIX 2: a complete, schema-valid ACEStepInput. actual_seeds/oss_steps are
    // List[int]; every sampler field upstream requires (no default) is present.
    expect(body).toEqual({
      checkpoint_path: CHECKPOINT_PATH,
      audio_duration: 45,
      prompt: "ambient",
      lyrics: "",
      infer_step: 27,
      guidance_scale: 15.0,
      actual_seeds: [7],
      oss_steps: [],
      output_path: OUTPUT_DIR,
      scheduler_type: "euler",
      cfg_type: "apg",
      omega_scale: 10.0,
      guidance_interval: 0.5,
      guidance_interval_decay: 0.0,
      min_guidance_scale: 3.0,
      use_erg_tag: true,
      use_erg_lyric: true,
      use_erg_diffusion: true,
      guidance_scale_text: 0.0,
      guidance_scale_lyric: 0.0,
    });
    expect(body).not.toHaveProperty("manual_seeds");
    expect(body).not.toHaveProperty("save_path");
  });

  it("auto duration + random seed -> actual_seeds:[] and synthesized seconds 0 / seed 0", async () => {
    const bodies: Record<string, unknown>[] = [];
    server.use(
      http.post(`${ACE_BASE}/generate`, async ({ request }) => {
        bodies.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({ status: "ok", output_path: "/out/a.wav" });
      }),
    );
    const result = await generateMusicImpl(makeCtx(makeClient("native")), { prompt: "x" });
    expect(structured(result)).toMatchObject({
      mode: "sync",
      wavPath: "/out/a.wav",
      seconds: 0,
      seed: 0,
    });
    // Unseeded -> empty list, ACE's "random" convention (empty -> set_seeds draws one).
    expect(bodies[0]?.actual_seeds).toEqual([]);
  });
});
