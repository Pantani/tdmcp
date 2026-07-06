import { setTimeout as delay } from "node:timers/promises";
import { capturePreview } from "../feedback/previewCapture.js";
import type { TouchDesignerClient } from "../td-client/touchDesignerClient.js";
import { friendlyTdError } from "../td-client/types.js";
import { classifyTdErrorExit, ExitCode } from "./exitCodes.js";
import { detectInlineProtocol, renderInlineImage, type TerminalEnv } from "./inlineImage.js";

export interface PreviewInlineOptions {
  nodePath: string;
  width: number;
  height: number;
  watch: boolean;
  /** Poll interval in ms when watching. */
  intervalMs: number;
  env?: TerminalEnv;
  /** Total watch frames to render before returning (undefined = run until aborted). */
  maxFrames?: number;
  signal?: AbortSignal;
}

export interface PreviewInlineResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Renders a TOP inline in the terminal. In `--watch` mode it re-renders on an
 * interval until aborted (Ctrl-C) or `maxFrames` is reached — a lightweight
 * "watch it cook" loop that reuses the same capture path as the one-shot render.
 *
 * Returns a CliResult-shaped object so the dispatcher can forward it directly.
 * Uses the exit-code taxonomy (3 offline, 4 TD error) on failure.
 */
export async function runPreviewInline(
  client: TouchDesignerClient,
  opts: PreviewInlineOptions,
  writeStdout: (chunk: string) => void = (chunk) => process.stdout.write(chunk),
): Promise<PreviewInlineResult> {
  const protocol = detectInlineProtocol(opts.env);

  const renderOnce = async (): Promise<{ ok: true } | { ok: false; message: string }> => {
    try {
      const preview = await capturePreview(client, opts.nodePath, opts.width, opts.height);
      const caption = `${preview.path}  ${preview.width}×${preview.height}`;
      writeStdout(
        renderInlineImage(preview.base64, {
          protocol,
          width: preview.width,
          height: preview.height,
          mimeType: preview.mimeType,
          caption,
          env: opts.env,
        }),
      );
      return { ok: true };
    } catch (err) {
      return { ok: false, message: friendlyTdError(err) };
    }
  };

  if (!opts.watch) {
    const r = await renderOnce();
    if (r.ok) return { code: ExitCode.Ok, stdout: "", stderr: "" };
    return { code: classifyTdErrorExit(r.message), stdout: "", stderr: `${r.message}\n` };
  }

  // Watch mode: re-render on an interval. A single capture failure is
  // non-fatal (the op may be mid-cook); we keep polling but track the last
  // error so an all-failure run still exits non-zero.
  let frames = 0;
  let lastError: string | undefined;
  let anySuccess = false;
  while (!opts.signal?.aborted) {
    const r = await renderOnce();
    if (r.ok) {
      anySuccess = true;
      lastError = undefined;
    } else {
      lastError = r.message;
      // Connection-level failure won't recover by polling — bail immediately.
      if (classifyTdErrorExit(r.message) === ExitCode.TdOffline) {
        return { code: ExitCode.TdOffline, stdout: "", stderr: `${r.message}\n` };
      }
    }
    frames += 1;
    if (opts.maxFrames !== undefined && frames >= opts.maxFrames) break;
    if (opts.signal?.aborted) break;
    await delay(opts.intervalMs);
  }

  if (anySuccess) return { code: ExitCode.Ok, stdout: "", stderr: "" };
  return {
    code: lastError ? classifyTdErrorExit(lastError) : ExitCode.Ok,
    stdout: "",
    stderr: lastError ? `${lastError}\n` : "",
  };
}
