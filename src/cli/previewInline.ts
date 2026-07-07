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

type FrameOutcome = { ok: true } | { ok: false; message: string };

/** Capture the TOP once and write it to the terminal. Errors become a typed outcome. */
async function renderPreviewFrame(
  client: TouchDesignerClient,
  opts: PreviewInlineOptions,
  protocol: ReturnType<typeof detectInlineProtocol>,
  writeStdout: (chunk: string) => void,
): Promise<FrameOutcome> {
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
}

/**
 * `--watch` loop: re-render on an interval until aborted or `maxFrames`. A single
 * capture failure is non-fatal (the op may be mid-cook) — polling continues but the
 * last error is tracked so an all-failure run still exits non-zero. A connection-level
 * failure won't recover by polling, so it bails immediately.
 */
interface WatchState {
  anySuccess: boolean;
  lastError: string | undefined;
}

/** Fold one frame outcome into the watch state, or bail on a connection-level failure. */
function applyFrameOutcome(
  outcome: FrameOutcome,
  state: WatchState,
): { bail: PreviewInlineResult } | undefined {
  if (outcome.ok) {
    state.anySuccess = true;
    state.lastError = undefined;
    return undefined;
  }
  state.lastError = outcome.message;
  if (classifyTdErrorExit(outcome.message) === ExitCode.TdOffline) {
    return { bail: { code: ExitCode.TdOffline, stdout: "", stderr: `${outcome.message}\n` } };
  }
  return undefined;
}

/** Final result once the watch loop ends without a hard bail. */
function watchLoopResult(state: WatchState): PreviewInlineResult {
  if (state.anySuccess) return { code: ExitCode.Ok, stdout: "", stderr: "" };
  return {
    code: state.lastError ? classifyTdErrorExit(state.lastError) : ExitCode.Ok,
    stdout: "",
    stderr: state.lastError ? `${state.lastError}\n` : "",
  };
}

/** True once the loop has hit its frame budget or an abort signal. */
function watchLoopDone(opts: PreviewInlineOptions, frames: number): boolean {
  if (opts.maxFrames !== undefined && frames >= opts.maxFrames) return true;
  return opts.signal?.aborted === true;
}

async function runWatchLoop(
  renderFrame: () => Promise<FrameOutcome>,
  opts: PreviewInlineOptions,
): Promise<PreviewInlineResult> {
  const state: WatchState = { anySuccess: false, lastError: undefined };
  let frames = 0;
  while (!opts.signal?.aborted) {
    const bailed = applyFrameOutcome(await renderFrame(), state);
    if (bailed) return bailed.bail;
    frames += 1;
    if (watchLoopDone(opts, frames)) break;
    await delay(opts.intervalMs);
  }
  return watchLoopResult(state);
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
  const renderFrame = () => renderPreviewFrame(client, opts, protocol, writeStdout);

  if (!opts.watch) {
    const r = await renderFrame();
    if (r.ok) return { code: ExitCode.Ok, stdout: "", stderr: "" };
    return { code: classifyTdErrorExit(r.message), stdout: "", stderr: `${r.message}\n` };
  }
  return runWatchLoop(renderFrame, opts);
}
