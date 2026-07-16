import { z } from "zod";
import {
  CALIBRATION_SCHEMA_VERSION,
  CalibrationManifestSchema,
  defaultCalibrationCachePath,
  FileCalibrationCache,
  probeCalibrationIdentity,
} from "../../llm/calibration.js";
import { LLM_SYSTEM_OPTION } from "../../llm/client.js";
import type { ToolContext } from "../types.js";
import {
  VISUAL_CRITIQUE_FIXTURE_RECEIPT_ID,
  VISUAL_CRITIQUE_FIXTURE_SUITE,
  VISUAL_CRITIQUE_RUBRIC_ID,
  type VisualCritiqueArgs,
  type VisualCritiqueDependencies,
  type VisualGateEvidence,
} from "./enhanceBuildVisualCritique.js";

const EXACT_MODEL = "qwen3-vl:8b-instruct-q4_K_M";
const EXACT_DIGEST = "0533d74300e4f9bc367d675d4e64ffd073d50ff16a2b4096cc2e8a1cf8c96319";
const EXACT_QUANTIZATION = "Q4_K_M";
const EXACT_FINGERPRINT = "sha256:c7439a25964685329e256ee9706aba340226068cbc5a652f802eef30d0ed1241";
const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;

const CalibrationCacheSchema = z
  .object({
    schema_version: z.literal(CALIBRATION_SCHEMA_VERSION),
    entries: z.array(CalibrationManifestSchema).max(64),
  })
  .strict();

const VISUAL_SYSTEM =
  "You are the bounded visual critic for TouchDesigner. Return one strict JSON object and no " +
  "other text. The top-level keys must be exactly rubric, summary, changes. Use this exact shape: " +
  '{"rubric":{"composition_hierarchy":0,"palette_coherence":0,' +
  '"contrast_legibility":0,"spatial_balance":0},"summary":"...","changes":[]}. ' +
  "All four rubric values are integer scores from 0 to 100 and summary is at most 240 " +
  "characters. Proposal targets are controls the operator explicitly selected for visual tuning. " +
  "In proposal mode, when targets are present and max_changes is positive, changes must contain " +
  "between one and max_changes conservative, in-bounds values different from current. Each " +
  "change must contain exactly target_id, " +
  "finite numeric value, rationale at most 160 characters, and risk low or medium. Never return " +
  "overall. Never infer paths or parameter names. In verification mode changes must be empty.";

function endpointFromDescriptor(ctx: ToolContext): { endpoint: string; model: string } {
  if (!ctx.llm) throw new Error("vision_unverified");
  const descriptor = ctx.llm.describe?.();
  if (
    !descriptor ||
    descriptor.transport !== "openai_compatible" ||
    descriptor.locality !== "loopback" ||
    descriptor.configuredModel !== EXACT_MODEL ||
    !descriptor.endpointOrigin
  ) {
    throw new Error("vision_unverified");
  }
  const configured = process.env.TDMCP_LLM_BASE_URL?.trim();
  const endpoint = configured || `${descriptor.endpointOrigin.replace(/\/+$/u, "")}/v1`;
  const parsed = new URL(endpoint);
  const hostname = parsed.hostname.toLowerCase();
  if (
    (hostname !== "127.0.0.1" && hostname !== "::1" && hostname !== "[::1]") ||
    parsed.pathname.replace(/\/+$/u, "") !== "/v1"
  ) {
    throw new Error("vision_unverified");
  }
  if (parsed.origin !== descriptor.endpointOrigin) throw new Error("vision_unverified");
  return { endpoint, model: EXACT_MODEL };
}

async function withGateDeadline<T>(
  external: AbortSignal | undefined,
  action: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  external?.addEventListener("abort", abort, { once: true });
  if (external?.aborted) controller.abort();
  const timer = setTimeout(abort, 3_000);
  try {
    return await action(controller.signal);
  } finally {
    clearTimeout(timer);
    external?.removeEventListener("abort", abort);
  }
}

function exactManifest(raw: unknown, fingerprint: string, now: number) {
  const cache = CalibrationCacheSchema.parse(raw);
  const manifest = cache.entries.find(
    (candidate) =>
      candidate.suite_version === VISUAL_CRITIQUE_FIXTURE_SUITE &&
      candidate.status === "PASS" &&
      candidate.identity.provider === "ollama" &&
      candidate.identity.model === EXACT_MODEL &&
      candidate.identity.digest === EXACT_DIGEST &&
      candidate.identity.quantization === EXACT_QUANTIZATION &&
      candidate.fingerprint === EXACT_FINGERPRINT &&
      candidate.fingerprint === fingerprint &&
      candidate.cache.reusable_for_mutation,
  );
  if (!manifest?.cache.expires_at) throw new Error("vision_unverified");
  const expiresAtMs = Date.parse(manifest.cache.expires_at);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) throw new Error("vision_unverified");
  const image = manifest.capabilities.find((capability) => capability.id === "image_input");
  if (
    !image ||
    image.status !== "PASS" ||
    image.samples.passed < 1 ||
    image.samples.failed !== 0 ||
    image.samples.unverified !== 0
  ) {
    throw new Error("vision_unverified");
  }
  return { manifest, image, expiresAtMs };
}

export async function resolveExactVisualGate(
  ctx: ToolContext,
  receiptId: string,
  signal?: AbortSignal,
): Promise<VisualGateEvidence> {
  if (receiptId !== VISUAL_CRITIQUE_FIXTURE_RECEIPT_ID) throw new Error("vision_unverified");
  const { endpoint, model } = endpointFromDescriptor(ctx);
  const probed = await withGateDeadline(signal, (boundedSignal) =>
    probeCalibrationIdentity({ endpoint, model, signal: boundedSignal }),
  );
  if (
    !probed.supportsVision ||
    probed.identity.provider !== "ollama" ||
    probed.identity.model !== EXACT_MODEL ||
    probed.identity.digest !== EXACT_DIGEST ||
    probed.identity.quantization !== EXACT_QUANTIZATION ||
    probed.fingerprint !== EXACT_FINGERPRINT
  ) {
    throw new Error("vision_unverified");
  }
  const cachePath = process.env.TDMCP_LLM_CALIBRATION_CACHE || defaultCalibrationCachePath();
  const raw = await new FileCalibrationCache().read(cachePath);
  const { manifest, image, expiresAtMs } = exactManifest(raw, probed.fingerprint, Date.now());
  return {
    identity: {
      provider: manifest.identity.provider,
      model: EXACT_MODEL,
      digest: EXACT_DIGEST,
      quantization: EXACT_QUANTIZATION,
      fingerprint: EXACT_FINGERPRINT,
      advertisesVision: true,
    },
    calibration: {
      status: "PASS",
      model: EXACT_MODEL,
      digest: EXACT_DIGEST,
      fingerprint: EXACT_FINGERPRINT,
      reusableForMutation: true,
      expiresAtMs,
      imageInput: {
        status: "PASS",
        passed: image.samples.passed,
        failed: image.samples.failed,
        unverified: image.samples.unverified,
      },
    },
    fixture: {
      result: "PASS",
      suite: VISUAL_CRITIQUE_FIXTURE_SUITE,
      rubricId: VISUAL_CRITIQUE_RUBRIC_ID,
      model: EXACT_MODEL,
      digest: EXACT_DIGEST,
      calibrationFingerprint: EXACT_FINGERPRINT,
      strictResponses: 6,
      goodSpread: 0,
      badSpread: 0,
      medianDelta: 39,
      expiresAtMs,
    },
  };
}

function visualPrompt(input: Parameters<VisualCritiqueDependencies["critique"]>[0]): string {
  return JSON.stringify({
    rubric_id: VISUAL_CRITIQUE_RUBRIC_ID,
    mode: input.mode,
    targets: input.targets,
    max_changes: input.maxChanges,
  });
}

export function createVisualCritiqueDependencies(
  ctx: ToolContext,
  scopePath: string,
  visual: VisualCritiqueArgs,
): VisualCritiqueDependencies {
  return {
    now: () => Date.now(),
    resolveGate: (signal) => resolveExactVisualGate(ctx, visual.fixtureReceiptId, signal),
    inspect: async (input) => {
      const report = await ctx.client.inspectVisualParameters({
        scope_path: input.scopePath,
        output_top_path: input.outputTopPath,
        targets: input.targets.map((target) => ({
          node_path: target.nodePath,
          parameter: target.parameter,
          minimum: target.minimum,
          maximum: target.maximum,
        })),
        ...(input.signal ? { signal: input.signal } : {}),
      });
      return {
        scopePath: report.scope_path,
        outputTopPath: report.output_top_path,
        fingerprint: report.fingerprint,
        targets: report.targets.map((target) => ({
          id: target.id as `t${1 | 2 | 3 | 4 | 5 | 6}`,
          path: target.path,
          parameter: target.parameter,
          type: target.type,
          mode: target.mode,
          value: target.value,
          minimum: target.minimum,
          maximum: target.maximum,
        })),
      };
    },
    capture: async (input) => {
      const context = await ctx.client.getEditorContext({
        timeoutMs: 2_000,
        retry: false,
        signal: input.signal,
      });
      if (context.perform_mode === true) throw new Error("perform_mode");
      const errors = await ctx.client.getNetworkErrors(scopePath, {
        timeoutMs: 2_000,
        retryGet: false,
        signal: input.signal,
      });
      const preview = await ctx.client.getPreview(input.outputTopPath, 640, 360, {
        timeoutMs: 5_000,
        retryGet: false,
        signal: input.signal,
      });
      if (
        preview.path !== input.outputTopPath ||
        preview.width !== 640 ||
        preview.height !== 360 ||
        preview.format.toLowerCase() !== "png" ||
        preview.base64.length > Math.ceil((MAX_PREVIEW_BYTES * 4) / 3) + 4
      ) {
        throw new Error("preview_unverified");
      }
      const decoded = Buffer.from(preview.base64, "base64");
      if (decoded.length === 0 || decoded.length > MAX_PREVIEW_BYTES) {
        throw new Error("preview_unverified");
      }
      return {
        base64: preview.base64,
        mimeType: "image/png",
        width: 640,
        height: 360,
        technical: {
          errorCount: errors.errors.length,
          previewReadable: true,
        },
      };
    },
    critique: async (input) => {
      if (!ctx.llm) throw new Error("vision_unverified");
      const result = await ctx.llm.complete(
        [
          {
            role: "user",
            content: [
              { type: "text", text: visualPrompt(input) },
              { type: "image", data: input.image.base64, mimeType: input.image.mimeType },
            ],
          },
        ],
        {
          [LLM_SYSTEM_OPTION]: VISUAL_SYSTEM,
          maxTokens: 700,
          temperature: 0,
          timeoutMs: 15_000,
          maxResponseBytes: 16 * 1024,
          ...(input.signal ? { signal: input.signal } : {}),
        },
      );
      if (result.model && result.model !== EXACT_MODEL) throw new Error("vision_unverified");
      const exact = await resolveExactVisualGate(ctx, visual.fixtureReceiptId, input.signal);
      return {
        text: result.text,
        identity: {
          model: exact.identity.model,
          digest: exact.identity.digest,
          fingerprint: exact.identity.fingerprint,
        },
      };
    },
    approve: async (input) => {
      const result = await ctx.client.requestVisualParameterDecision({
        expected_fingerprint: input.expectedFingerprint,
        proposal_digest: input.proposalDigest,
        changes: input.changes.map((change) => ({
          target_id: change.targetId,
          value: change.value,
        })),
        timeout_ms: input.ttlMs,
        dedupe_key: input.dedupeKey,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      return { requestId: result.request_id, state: result.state, choice: result.choice };
    },
    commit: async (input) => {
      const result = await ctx.client.commitVisualParameters({
        scope_path: input.scopePath,
        output_top_path: input.outputTopPath,
        expected_fingerprint: input.expectedFingerprint,
        proposal_digest: input.proposalDigest,
        idempotency_key: input.idempotencyKey,
        interaction_id: input.interactionId,
        changes: input.changes.map((change) => ({
          target_id: change.targetId,
          value: change.value,
        })),
        ...(input.signal ? { signal: input.signal } : {}),
      });
      if (result.status !== "committed") return result;
      return {
        status: "committed",
        applied: true,
        verified: true,
        finalFingerprint: result.final_fingerprint,
        restoreToken: result.restore_token,
        readback: result.readback.map((item) => ({
          targetId: item.target_id,
          value: item.value,
        })),
        ...(result.undo_label ? { undoLabel: result.undo_label } : {}),
      };
    },
    restore: async (input) => {
      const result = await ctx.client.restoreVisualParameters({
        restore_token: input.restoreToken,
        expected_committed_fingerprint: input.expectedCommittedFingerprint,
        idempotency_key: input.idempotencyKey,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      return {
        restored: result.restored,
        verified: result.verified,
        ...(result.restored_fingerprint
          ? { restoredFingerprint: result.restored_fingerprint }
          : {}),
        ...(result.undo_label ? { undoLabel: result.undo_label } : {}),
        ...(result.reason ? { reason: result.reason } : {}),
      };
    },
  };
}
