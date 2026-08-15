import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AceStepClient } from "../../src/ace-client/aceStepClient.js";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { type AceToolContext, generateMusicImpl } from "../../src/tools/layer3/generateMusic.js";
import type { ToolExtra } from "../../src/tools/types.js";
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

function makeClient(over: { rtf?: number; syncMaxSeconds?: number } = {}): AceStepClient {
  return new AceStepClient({
    baseUrl: ACE_BASE,
    timeoutMs: 2000,
    defaultSteps: 27,
    outputDir: OUTPUT_DIR,
    pollMs: 1,
    ...over,
  });
}

/**
 * P2: the sync branch now goes POST /jobs + poll GET /jobs/{id} (same worker path
 * the wrapper's POST /generate used internally) — that is what makes progress and
 * real cancellation possible. Capture the submit body and reply `done` on first poll.
 */
function captureJobs(status: Record<string, unknown>): { bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = [];
  server.use(
    http.post(`${ACE_BASE}/jobs`, async ({ request }) => {
      bodies.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json({ job_id: "job-1" });
    }),
    http.get(`${ACE_BASE}/jobs/job-1`, () => HttpResponse.json(status)),
  );
  return { bodies };
}

const OK_JOB = { status: "done", wavPath: "/out/output_x.wav", seconds: 30.0, seed: 42 };

function textOf(result: { content: { type: string }[] }): string | undefined {
  return (result.content.find((c) => c.type === "text") as { text: string } | undefined)?.text;
}

describe("generate_music", () => {
  it("happy path (sync): wavPath/seconds/seed + mode:'sync' in structuredContent", async () => {
    captureJobs(OK_JOB);
    const result = await generateMusicImpl(makeCtx(makeClient()), {
      prompt: "lofi hip hop, mellow",
    });
    expect(result.isError).toBeFalsy();
    const sc = (result as { structuredContent?: Record<string, unknown> }).structuredContent ?? {};
    expect(sc.mode).toBe("sync");
    expect(sc.wavPath).toBe("/out/output_x.wav");
    expect(sc.seconds).toBe(30.0);
    expect(sc.seed).toBe(42);
    expect(textOf(result)).toContain("/out/output_x.wav");
  });

  it("injects the tdmcp defaults (infer_step 27, guidance_scale 15.0, save_path outputDir)", async () => {
    const { bodies } = captureJobs(OK_JOB);
    await generateMusicImpl(makeCtx(makeClient()), { prompt: "ambient drone" });
    expect(bodies).toHaveLength(1);
    const body = bodies[0] ?? {};
    expect(body.infer_step).toBe(27);
    expect(body.guidance_scale).toBe(15.0);
    expect(body.save_path).toBe(OUTPUT_DIR);
  });

  it("manual_seeds: omitted -> null in body, seed surfaced; provided -> carried in body", async () => {
    const cap1 = captureJobs(OK_JOB);
    const omitted = await generateMusicImpl(makeCtx(makeClient()), { prompt: "techno" });
    expect(cap1.bodies[0]?.manual_seeds).toBeNull();
    expect((omitted as { structuredContent?: { seed?: number } }).structuredContent?.seed).toBe(42);

    const cap2 = captureJobs({ ...OK_JOB, seed: 123 });
    await generateMusicImpl(makeCtx(makeClient()), { prompt: "techno", manual_seeds: 123 });
    expect(cap2.bodies[0]?.manual_seeds).toBe(123);
  });

  it("mode:'job' -> job_id + poll guidance, no WAV", async () => {
    captureJobs(OK_JOB);
    const result = await generateMusicImpl(makeCtx(makeClient()), {
      prompt: "long ambient piece",
      mode: "job",
    });
    expect(result.isError).toBeFalsy();
    const sc = (result as { structuredContent?: Record<string, unknown> }).structuredContent ?? {};
    expect(sc.mode).toBe("job");
    expect(sc.job_id).toBe("job-1");
    expect(sc.wavPath).toBeUndefined();
    expect(textOf(result)).toContain("poll get_music_job");
  });

  it("mode:'auto' with a calibrated RTF over the threshold hands off to a job", async () => {
    captureJobs(OK_JOB);
    // rtf 5 * 120 s audio = 600 s estimate > syncMaxSeconds 120
    const client = makeClient({ rtf: 5, syncMaxSeconds: 120 });
    const result = await generateMusicImpl(makeCtx(client), {
      prompt: "epic",
      audio_duration: 120,
    });
    const sc = (result as { structuredContent?: Record<string, unknown> }).structuredContent ?? {};
    expect(sc.mode).toBe("job");
    expect(sc.estimated_seconds).toBe(600);
  });

  it("mode:'auto' with RTF uncalibrated stays SYNC (F6 is inert by default)", async () => {
    captureJobs(OK_JOB);
    const result = await generateMusicImpl(makeCtx(makeClient()), { prompt: "anything" });
    const sc = (result as { structuredContent?: Record<string, unknown> }).structuredContent ?? {};
    expect(sc.mode).toBe("sync");
    // The sync branch self-calibrates: it reports what it measured.
    expect(textOf(result)).toContain("wall-clock");
  });

  it("emits notifications/progress when the client supplied a progressToken", async () => {
    captureJobs(OK_JOB);
    const sendNotification = vi.fn(async () => {});
    const extra = {
      signal: new AbortController().signal,
      requestId: 1,
      sendNotification,
      sendRequest: vi.fn(),
      _meta: { progressToken: "t1" },
    } as unknown as ToolExtra;
    await generateMusicImpl(makeCtx(makeClient()), { prompt: "techno" }, extra);
    expect(sendNotification).toHaveBeenCalled();
    const call = (sendNotification.mock.calls as unknown as unknown[][])[0]?.[0] as {
      method: string;
      params: { progressToken: string };
    };
    expect(call.method).toBe("notifications/progress");
    expect(call.params.progressToken).toBe("t1");
  });

  it("no extra (the CLI path) -> works, zero notifications, no crash", async () => {
    captureJobs(OK_JOB);
    const result = await generateMusicImpl(makeCtx(makeClient()), { prompt: "techno" });
    expect(result.isError).toBeFalsy();
  });

  it("invalid args (empty prompt) -> errorResult, no throw", async () => {
    const result = await generateMusicImpl(makeCtx(makeClient()), { prompt: "" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Invalid arguments");
  });

  it("invalid mode -> errorResult, no throw", async () => {
    const result = await generateMusicImpl(makeCtx(makeClient()), {
      prompt: "techno",
      mode: "nope",
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Invalid arguments");
  });

  it("ACE unreachable -> friendly errorResult, no throw", async () => {
    server.use(http.post(`${ACE_BASE}/jobs`, () => HttpResponse.error()));
    const result = await generateMusicImpl(makeCtx(makeClient()), { prompt: "jazz" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Cannot reach the ACE-Step wrapper");
  });

  it("API 500 {ok:false} -> friendly errorResult, no throw", async () => {
    server.use(
      http.post(`${ACE_BASE}/jobs`, () =>
        HttpResponse.json({ ok: false, error: "pipeline crashed" }, { status: 500 }),
      ),
    );
    const result = await generateMusicImpl(makeCtx(makeClient()), { prompt: "orchestral" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("pipeline crashed");
  });

  it("job reports an error status -> friendly errorResult, no throw", async () => {
    captureJobs({ status: "error", error: "CUDA out of memory" });
    const result = await generateMusicImpl(makeCtx(makeClient()), { prompt: "huge" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("CUDA out of memory");
  });

  it("disabled gate: aceClient undefined -> friendly error without touching the network", async () => {
    // No handler registered; onUnhandledRequest:"error" would fail the test if a
    // request went out. The disabled guard must short-circuit before any fetch.
    const result = await generateMusicImpl(makeCtx(undefined), { prompt: "anything" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("TDMCP_ACE_ENABLED=1");
  });
});
