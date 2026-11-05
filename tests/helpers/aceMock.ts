import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpResponse, http } from "msw";
import type { SetupServerApi } from "msw/node";

/** The ACE-Step 1.5 REST contract, as `acestep/api/http/*` answers it upstream. */
export const ACE_BASE = "http://127.0.0.1:8001";
export const ACE_AUDIO_BYTES = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]);

export function aceOutputDir(): string {
  return mkdtempSync(join(tmpdir(), "tdmcp-ace-"));
}

function wrap(data: unknown) {
  return { data, code: 200, error: null, timestamp: 1700000000000, extra: null };
}

type Row = Record<string, unknown>;

export function runningRow(progress = 0, stage = "queued"): Row {
  const item = { file: "", status: 0, progress, stage, error: null };
  return { status: 0, result: JSON.stringify([item]), progress_text: "" };
}

export function succeededRow(over: { duration?: number; seed_value?: string } = {}): Row {
  const item = {
    file: `/v1/audio?path=${encodeURIComponent("/tmp/api_audio/abc.wav")}`,
    status: 1,
    metas: { duration: over.duration ?? 30 },
    ...(over.seed_value !== undefined ? { seed_value: over.seed_value } : {}),
  };
  return { status: 1, result: JSON.stringify([item]), progress_text: "" };
}

export function failedRow(error: string): Row {
  return { status: 2, result: JSON.stringify([{ file: "", status: 2, error }]) };
}

export const UNKNOWN_ROW: Row = { status: 0, result: "[]" };

export interface AceMockHits {
  bodies: Record<string, unknown>[];
  queries: Record<string, unknown>[];
  audioRequests: Request[];
  submitRequests: Request[];
}

/** Scripted server: one submit, then `rows` in order (the last one repeats). */
export function mockAce(server: SetupServerApi, rows: Row[], taskId = "task-1"): AceMockHits {
  const hits: AceMockHits = { bodies: [], queries: [], audioRequests: [], submitRequests: [] };
  server.use(
    http.post(`${ACE_BASE}/release_task`, async ({ request }) => {
      hits.submitRequests.push(request.clone());
      hits.bodies.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json(wrap({ task_id: taskId, status: "queued", queue_position: 1 }));
    }),
    http.post(`${ACE_BASE}/query_result`, async ({ request }) => {
      hits.queries.push((await request.json()) as Record<string, unknown>);
      const row = rows[Math.min(hits.queries.length - 1, rows.length - 1)];
      return HttpResponse.json(wrap([{ task_id: taskId, ...row }]));
    }),
    http.get(`${ACE_BASE}/v1/audio`, ({ request }) => {
      hits.audioRequests.push(request);
      return new HttpResponse(ACE_AUDIO_BYTES, { headers: { "content-type": "audio/wav" } });
    }),
  );
  return hits;
}
