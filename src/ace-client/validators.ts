import { z } from "zod";

/**
 * The ACE-Step wrapper's `POST /generate` success envelope.
 *
 * `wavPath` is the ACTUAL written path the wrapper reports (source-verified:
 * `ACEStepPipeline.__call__` returns the written path list — never predicted).
 * Non-strict on purpose: forward-compat unknown fields are allowed (do NOT add
 * `.strict()`), so a richer future wrapper response still parses under `@main`.
 */
export const GenerateResultSchema = z.object({
  wavPath: z.string(),
  seconds: z.number(),
  seed: z.number().int(),
});

export type GenerateResult = z.infer<typeof GenerateResultSchema>;

/** The ACE-Step wrapper's `GET /health` envelope. */
export const AceHealthSchema = z.object({
  status: z.string(),
  model_loaded: z.boolean().default(false),
  device: z.string().optional(),
});

export type AceHealth = z.infer<typeof AceHealthSchema>;

/**
 * The artist-facing request the tool hands to `AceStepClient.generate()`. The
 * client fills `infer_step` (from `defaultSteps` when omitted), `guidance_scale`
 * (15.0 when omitted) and `save_path` (= `outputDir`) at the wire boundary.
 */
export interface AceGenerateRequest {
  prompt: string;
  lyrics?: string;
  audio_duration: number;
  manual_seeds?: number;
  infer_step?: number;
  guidance_scale?: number;
}

/** ace/ wrapper `POST /jobs` — async submit acknowledgement. */
export const JobSubmitSchema = z.object({ job_id: z.string() });
export type JobSubmit = z.infer<typeof JobSubmitSchema>;

/**
 * ace/ wrapper `GET /jobs/{id}` — job status. Result fields are present only
 * when `status="done"`; `.nullish()` so a wrapper emitting explicit `null` for
 * not-yet-known fields parses cleanly. Non-strict for forward-compat.
 */
export const JobStatusSchema = z.object({
  status: z.enum(["queued", "running", "done", "error", "cancelled"]),
  wavPath: z.string().nullish(),
  seconds: z.number().nullish(),
  seed: z.number().int().nullish(),
  error: z.string().nullish(),
});
export type JobStatus = z.infer<typeof JobStatusSchema>;

/** ace/ wrapper `POST /jobs/{id}/cancel`. */
export const JobCancelSchema = z.object({
  cancelled: z.boolean(),
  status: z.string().optional(),
});
export type JobCancel = z.infer<typeof JobCancelSchema>;

/**
 * Native `infer-api.py` `POST /generate` — ACEStepOutput (source-verified Q1).
 * Carries neither seconds nor seed; the client synthesizes those from the request.
 */
export const NativeGenerateResultSchema = z.object({
  status: z.string(),
  output_path: z.string().nullish(),
  message: z.string().optional(),
});
export type NativeGenerateResult = z.infer<typeof NativeGenerateResultSchema>;
