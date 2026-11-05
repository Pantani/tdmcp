import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AceStepClient } from "../../src/ace-client/aceStepClient.js";
import { AceApiError, AceConnectionError } from "../../src/ace-client/types.js";
import { loadConfig } from "../../src/utils/config.js";
import {
  ACE_AUDIO_BYTES,
  ACE_BASE,
  aceOutputDir,
  failedRow,
  mockAce,
  runningRow,
  succeededRow,
  UNKNOWN_ROW,
} from "../helpers/aceMock.js";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function makeClient(over: { token?: string; outputDir?: string; defaultSteps?: number } = {}) {
  return new AceStepClient({
    baseUrl: ACE_BASE,
    timeoutMs: 2000,
    outputDir: over.outputDir ?? aceOutputDir(),
    ...over,
  });
}

function queryReturning(row: Record<string, unknown>) {
  server.use(
    http.post(`${ACE_BASE}/query_result`, () =>
      HttpResponse.json({ data: [{ task_id: "task-1", ...row }], code: 200, error: null }),
    ),
  );
}

describe("AceStepClient.submitGenerate", () => {
  it("pins one WAV and omits what the caller left out, so upstream defaults apply", async () => {
    const hits = mockAce(server, []);
    const { job_id } = await makeClient().submitGenerate({ prompt: "techno" });
    expect(job_id).toBe("task-1");
    expect(hits.bodies[0]).toEqual({
      prompt: "techno",
      inference_steps: 8,
      batch_size: 1,
      audio_format: "wav",
    });
  });

  it("maps a pinned seed onto use_random_seed:false + seed", async () => {
    const hits = mockAce(server, []);
    await makeClient().submitGenerate({
      prompt: "techno",
      lyrics: "[verse] hi",
      audio_duration: 30,
      seed: 42,
      inference_steps: 12,
      guidance_scale: 5,
    });
    expect(hits.bodies[0]).toMatchObject({
      lyrics: "[verse] hi",
      audio_duration: 30,
      use_random_seed: false,
      seed: 42,
      inference_steps: 12,
      guidance_scale: 5,
    });
  });

  it("sends the API key as a bearer token", async () => {
    const hits = mockAce(server, []);
    await makeClient({ token: "s3cret" }).submitGenerate({ prompt: "techno" });
    expect(hits.submitRequests[0]?.headers.get("authorization")).toBe("Bearer s3cret");
  });

  it("surfaces FastAPI's detail (queue full) as an AceApiError with the status", async () => {
    server.use(
      http.post(`${ACE_BASE}/release_task`, () =>
        HttpResponse.json({ detail: "Server busy: queue is full" }, { status: 429 }),
      ),
    );
    const err = await makeClient()
      .submitGenerate({ prompt: "techno" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AceApiError);
    expect((err as AceApiError).message).toContain("queue is full");
    expect((err as AceApiError).status).toBe(429);
  });

  it("surfaces an error carried by a 200 envelope", async () => {
    server.use(
      http.post(`${ACE_BASE}/release_task`, () =>
        HttpResponse.json({ data: null, code: 500, error: "model not loaded" }),
      ),
    );
    await expect(makeClient().submitGenerate({ prompt: "x" })).rejects.toThrow("model not loaded");
  });

  it("reports a connection failure naming how to start the server", async () => {
    server.use(http.post(`${ACE_BASE}/release_task`, () => HttpResponse.error()));
    const err = await makeClient()
      .submitGenerate({ prompt: "x" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AceConnectionError);
    expect((err as Error).message).toContain("acestep-api");
  });
});

describe("AceStepClient.getJob", () => {
  it("reports a running job with upstream's progress and stage", async () => {
    mockAce(server, [runningRow(0.4, "diffusion")]);
    expect(await makeClient().getJob("task-1")).toEqual({
      status: "running",
      progress: 0.4,
      stage: "diffusion",
    });
  });

  it("downloads a finished job into outputDir and returns an absolute path", async () => {
    const outputDir = aceOutputDir();
    const hits = mockAce(server, [succeededRow({ duration: 42.5, seed_value: "7,9" })]);
    const job = await makeClient({ outputDir }).getJob("task-1");
    expect(job).toEqual({
      status: "done",
      wavPath: join(outputDir, "task-1.wav"),
      seconds: 42.5,
      seed: 7,
    });
    expect(isAbsolute(job.wavPath ?? "")).toBe(true);
    expect(new Uint8Array(readFileSync(job.wavPath ?? ""))).toEqual(ACE_AUDIO_BYTES);
    expect(hits.queries[0]).toEqual({ task_id_list: ["task-1"] });
    expect(readdirSync(outputDir)).toEqual(["task-1.wav"]);
  });

  it("downloads only once when a finished job is polled again", async () => {
    const hits = mockAce(server, [succeededRow()]);
    const client = makeClient();
    const first = await client.getJob("task-1");
    const second = await client.getJob("task-1");
    expect(second.wavPath).toBe(first.wavPath);
    expect(hits.audioRequests).toHaveLength(1);
  });

  it("sends the API key when downloading", async () => {
    const hits = mockAce(server, [succeededRow()]);
    await makeClient({ token: "s3cret" }).getJob("task-1");
    expect(hits.audioRequests[0]?.headers.get("authorization")).toBe("Bearer s3cret");
  });

  it("omits seconds and seed when the server does not report them", async () => {
    const row = succeededRow();
    const [item] = JSON.parse(row.result as string) as Record<string, unknown>[];
    queryReturning({ ...row, result: JSON.stringify([{ ...item, metas: { duration: -1 } }]) });
    server.use(http.get(`${ACE_BASE}/v1/audio`, () => new HttpResponse(ACE_AUDIO_BYTES)));
    const job = await makeClient().getJob("task-1");
    expect(job.status).toBe("done");
    expect(job).not.toHaveProperty("seconds");
    expect(job).not.toHaveProperty("seed");
  });

  it.each([
    ["another host", "http://evil.example/v1/audio?path=a.wav"],
    ["another route", "/v1/models?path=a.wav"],
  ])("never follows an audio URL on %s, so the API key cannot leak", async (_name, file) => {
    queryReturning({ status: 1, result: JSON.stringify([{ file, status: 1 }]) });
    const outputDir = aceOutputDir();
    // onUnhandledRequest:"error" also fails this test if a request goes out.
    await expect(makeClient({ outputDir, token: "s3cret" }).getJob("task-1")).rejects.toThrow(
      "unexpected audio URL",
    );
    expect(readdirSync(outputDir)).toEqual([]);
  });

  it("keeps a job id from escaping outputDir", async () => {
    const outputDir = aceOutputDir();
    mockAce(server, [succeededRow()]);
    const job = await makeClient({ outputDir }).getJob("../../etc/evil");
    expect(job.wavPath?.startsWith(outputDir)).toBe(true);
    expect(readdirSync(outputDir)).toHaveLength(1);
  });

  it("leaves nothing behind when the download fails", async () => {
    const outputDir = aceOutputDir();
    queryReturning(succeededRow());
    server.use(http.get(`${ACE_BASE}/v1/audio`, () => new HttpResponse(null, { status: 403 })));
    await expect(makeClient({ outputDir }).getJob("task-1")).rejects.toThrow("HTTP 403");
    expect(existsSync(join(outputDir, "task-1.wav"))).toBe(false);
  });

  it("treats status 0 with an empty result as an unknown job, not as still running", async () => {
    queryReturning(UNKNOWN_ROW);
    await expect(makeClient().getJob("nope")).rejects.toThrow("does not know job nope");
  });

  it("reports a failed job with upstream's error", async () => {
    queryReturning(failedRow("CUDA out of memory"));
    expect(await makeClient().getJob("task-1")).toEqual({
      status: "error",
      error: "CUDA out of memory",
    });
  });

  it("reports a failed job whose result is raw text instead of JSON", async () => {
    queryReturning({ status: 2, result: "worker exploded" });
    expect(await makeClient().getJob("task-1")).toEqual({
      status: "error",
      error: "worker exploded",
    });
  });

  it("errors when a finished job has no audio file", async () => {
    queryReturning({ status: 1, result: JSON.stringify([{ file: "", status: 1 }]) });
    await expect(makeClient().getJob("task-1")).rejects.toThrow("without an audio file");
  });

  it("accepts an already-decoded result array", async () => {
    const row = succeededRow();
    server.use(http.get(`${ACE_BASE}/v1/audio`, () => new HttpResponse(ACE_AUDIO_BYTES)));
    queryReturning({ ...row, result: JSON.parse(row.result as string) });
    expect((await makeClient().getJob("task-1")).status).toBe("done");
  });

  it("rejects an envelope with an unexpected shape", async () => {
    server.use(
      http.post(`${ACE_BASE}/query_result`, () => HttpResponse.json({ data: { nope: true } })),
    );
    await expect(makeClient().getJob("task-1")).rejects.toThrow("Unexpected data shape");
  });
});

describe("AceStepClient.health", () => {
  it("unwraps the envelope", async () => {
    server.use(
      http.get(`${ACE_BASE}/health`, () =>
        HttpResponse.json({ data: { status: "ok", service: "ACE-Step API", version: "1.0" } }),
      ),
    );
    expect(await makeClient().health()).toEqual({
      status: "ok",
      service: "ACE-Step API",
      version: "1.0",
    });
  });
});

describe("ACE config defaults", () => {
  it("targets acestep-api's port and turbo's step count", () => {
    expect(loadConfig({})).toMatchObject({
      aceEnabled: false,
      acePort: 8001,
      aceDefaultSteps: 8,
    });
  });
});
