import { z } from "zod";
import { capturePreview } from "../../feedback/previewCapture.js";
import type { TdAdvancedCapture, TdPreviewJob } from "../../td-client/validators.js";
import { errorResult, guardTd, imageResult, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const getPreviewSchema = z.object({
  node_path: z
    .string()
    .optional()
    .describe(
      "Path of the TOP node to capture. Required unless collecting a deferred job by job_id.",
    ),
  width: z.coerce
    .number()
    .int()
    .positive()
    .max(4096)
    .default(640)
    .describe(
      "Requested preview width (1–4096; default 640). The bridge may return a TOP's native output width; the caption reports the returned size.",
    ),
  height: z.coerce
    .number()
    .int()
    .positive()
    .max(4096)
    .default(360)
    .describe(
      "Requested preview height (1–4096; default 360). The bridge may return a TOP's native output height; the caption reports the returned size.",
    ),
  sample_grid: z.coerce
    .number()
    .int()
    .min(2)
    .max(16)
    .optional()
    .describe(
      "When set (2–16), return a lightweight N×N grid of RGBA samples + per-channel min/max/mean as JSON instead of an image — 10–50× cheaper. Use this when you only need to know whether the output is alive / roughly what colour it is, not its spatial detail.",
    ),
  pre_pulses: z
    .array(z.object({ path: z.string(), par: z.string() }))
    .optional()
    .describe(
      "Parameters to pulse in the SAME frame immediately before capturing — e.g. reset a feedback loop or fire a timer so a transient is actually visible. All targets are validated before any fires (all-or-nothing).",
    ),
  delay_frames: z.coerce
    .number()
    .int()
    .positive()
    .max(600)
    .optional()
    .describe(
      "Defer the capture by N frames (to catch an event that appears a few frames after a pulse). Returns a job_id + wait_ms instead of the image; call get_preview again with that job_id to collect the result.",
    ),
  job_id: z
    .string()
    .optional()
    .describe("Collect a previously deferred capture (from a delay_frames call) by its job_id."),
});
type GetPreviewArgs = z.infer<typeof getPreviewSchema>;

const MIME_BY_FORMAT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
};

function previewCaption(
  path: string,
  actualWidth: number,
  actualHeight: number,
  requestedWidth: number,
  requestedHeight: number,
): string {
  const actual = `${actualWidth}×${actualHeight}`;
  const requested = `${requestedWidth}×${requestedHeight}`;
  const dimensionNote = actual === requested ? actual : `${actual} native; ${requested} requested`;
  return `Preview of ${path} (${dimensionNote}).`;
}

function renderAdvanced(
  res: TdAdvancedCapture,
  path: string,
  requestedWidth: number,
  requestedHeight: number,
) {
  if ("status" in res) {
    return jsonResult(
      `Capturing ${path} in ${res.delay_frames} frame(s) (~${res.wait_ms}ms). ` +
        `Call get_preview again with job_id="${res.job_id}" to collect it.`,
      res,
    );
  }
  if ("samples" in res) {
    return jsonResult(`Sampled ${path} on a ${res.grid}×${res.grid} grid.`, res);
  }
  return imageResult(
    res.base64,
    MIME_BY_FORMAT[res.format] ?? "image/png",
    previewCaption(path, res.width, res.height, requestedWidth, requestedHeight),
  );
}

function renderJob(job: TdPreviewJob) {
  if (job.status === "pending") {
    return jsonResult(
      `Capture ${job.job_id} is still pending; call again shortly with the same job_id.`,
      job,
    );
  }
  if (job.status === "expired") {
    return jsonResult(
      `Capture ${job.job_id} expired or is unknown (deferred jobs live ~120s). Re-issue the capture.`,
      job,
    );
  }
  if (job.status === "error") {
    return errorResult(`Deferred capture ${job.job_id} failed: ${job.error ?? "unknown error"}.`);
  }
  const preview = job.preview;
  if (preview && "base64" in preview) {
    return imageResult(
      preview.base64,
      MIME_BY_FORMAT[preview.format] ?? "image/png",
      `Deferred preview (${job.job_id}).`,
    );
  }
  return jsonResult(`Deferred capture ${job.job_id} ready.`, job);
}

function isAdvanced(args: GetPreviewArgs): boolean {
  return (args.pre_pulses?.length ?? 0) > 0 || args.delay_frames !== undefined;
}

export async function getPreviewImpl(ctx: ToolContext, args: GetPreviewArgs) {
  if (args.job_id) {
    return guardTd(
      () => ctx.client.collectPreviewJob(args.job_id as string),
      (job) => renderJob(job),
    );
  }
  const nodePath = args.node_path;
  if (!nodePath) {
    return errorResult(
      "node_path is required to capture a preview (only omit it when collecting a deferred capture by job_id).",
    );
  }
  if (isAdvanced(args)) {
    return guardTd(
      () =>
        ctx.client.captureAdvanced(nodePath, {
          width: args.width,
          height: args.height,
          sampleGrid: args.sample_grid,
          prePulses: args.pre_pulses,
          delayFrames: args.delay_frames,
        }),
      (res) => renderAdvanced(res, nodePath, args.width, args.height),
    );
  }
  if (args.sample_grid !== undefined) {
    const n = args.sample_grid;
    return guardTd(
      () => ctx.client.sampleGrid(nodePath, n),
      (grid) =>
        jsonResult(
          `Sampled ${grid.path} on a ${grid.grid}×${grid.grid} grid (source ${grid.width}×${grid.height}).`,
          grid,
        ),
    );
  }
  return guardTd(
    () => capturePreview(ctx.client, nodePath, args.width, args.height),
    (preview) =>
      imageResult(
        preview.base64,
        preview.mimeType,
        previewCaption(nodePath, preview.width, preview.height, args.width, args.height),
      ),
  );
}

export const registerGetPreview: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "get_preview",
    {
      title: "Preview a TOP",
      description:
        "Capture a TOP node's current output as an inline PNG image. This is read-only. The bridge may return the TOP's native output dimensions instead of the requested width×height; when they differ, the caption shows both. Only TOPs can be previewed (CHOP/SOP/etc. have no image). For a cheaper check of activity and approximate colour, pass sample_grid=N to return an N×N grid of RGBA samples and per-channel statistics instead of an image.",
      inputSchema: getPreviewSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    (args) => getPreviewImpl(ctx, args),
  );
};
