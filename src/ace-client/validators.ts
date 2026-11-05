import { z } from "zod";

/**
 * Contract of the ACE-Step 1.5 REST server (`acestep-api`, default port 8001),
 * source-verified against `ace-step/ACE-Step-1.5` (`acestep/api/http/*`).
 *
 * Every schema is non-strict on purpose: upstream adds fields often, and an
 * unknown field must never break a generation.
 */

/** The unified `{ data, code, error, timestamp, extra }` response wrapper. */
function envelope<T extends z.ZodType>(data: T) {
  return z.object({ data });
}

/** `POST /release_task` — submission acknowledgement. */
export const ReleaseTaskSchema = envelope(z.object({ task_id: z.string().min(1) }));

/** One row of `POST /query_result`. `status`: 0 queued/running, 1 succeeded, 2 failed. */
export const QueryResultRowSchema = z.object({
  task_id: z.string().optional(),
  status: z.number().int(),
  /** A JSON-encoded array of result items (upstream double-encodes it). */
  result: z.union([z.string(), z.array(z.unknown())]).nullish(),
  progress_text: z.string().nullish(),
});
export type QueryResultRow = z.infer<typeof QueryResultRowSchema>;

export const QueryResultSchema = envelope(z.array(QueryResultRowSchema));

/** One item of a row's decoded `result` array. */
export const ResultItemSchema = z.object({
  /** Relative download URL, normally `/v1/audio?path=<encoded>`. Empty until succeeded. */
  file: z.string().nullish(),
  metas: z.object({ duration: z.number().nullish() }).nullish(),
  /** Comma-separated seeds. Upstream only includes it on its local-cache read path. */
  seed_value: z.union([z.string(), z.number()]).nullish(),
  /** 0..1 progress, present while queued/running. */
  progress: z.number().nullish(),
  stage: z.string().nullish(),
  error: z.string().nullish(),
});
export type ResultItem = z.infer<typeof ResultItemSchema>;

/** `GET /health`. */
export const AceHealthSchema = envelope(
  z.object({ status: z.string(), service: z.string().optional(), version: z.string().optional() }),
);
export type AceHealth = z.infer<typeof AceHealthSchema>["data"];

/** The result of a finished generation, after the audio was copied to the output dir. */
export interface GenerateResult {
  /** Absolute local path of the downloaded audio file. */
  wavPath: string;
  seconds: number;
  /** Unset when the server did not report one and the caller did not pin one. */
  seed?: number;
}

/**
 * The artist-facing request. Field names match `/release_task`, so `audio_duration`
 * omitted means "let the model choose".
 */
export interface AceGenerateRequest {
  prompt: string;
  lyrics?: string;
  audio_duration?: number;
  seed?: number;
  inference_steps?: number;
  guidance_scale?: number;
}

/** A job as tdmcp reports it. Upstream has one running state, so no `queued` here. */
export interface JobStatus {
  status: "running" | "done" | "error";
  wavPath?: string;
  seconds?: number;
  seed?: number;
  error?: string;
  /** Upstream's 0..1 estimate. Real, but coarse. */
  progress?: number;
  stage?: string;
}
