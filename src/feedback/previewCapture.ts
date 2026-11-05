import type {
  TdReadRequestOptions,
  TouchDesignerClient,
} from "../td-client/touchDesignerClient.js";
import { friendlyTdError, isMissingEndpoint, TdApiError } from "../td-client/types.js";

/** A capture was withheld because Perform mode is on or could not be ruled out. */
export class PreviewWithheldError extends TdApiError {
  constructor(message: string) {
    super(message);
    this.name = "PreviewWithheldError";
  }
}

export interface PreviewResult {
  path: string;
  width: number;
  height: number;
  base64: string;
  mimeType: string;
}

/** Captures a TOP as a base64 image via the bridge preview endpoint, if allowed. */
export async function capturePreview(
  client: TouchDesignerClient,
  path: string,
  width = 640,
  height = 360,
): Promise<PreviewResult> {
  await assertNotPerforming(client);
  const preview = await client.getPreview(path, width, height);
  return {
    path: preview.path,
    width: preview.width,
    height: preview.height,
    base64: preview.base64,
    mimeType: `image/${preview.format || "png"}`,
  };
}

/**
 * Call before any preview capture. Throws while Perform mode is active, and also when
 * that state can't be read: a preview is nonessential, so losing one costs less than
 * rendering during a show.
 */
export async function assertNotPerforming(
  client: TouchDesignerClient,
  options?: TdReadRequestOptions,
): Promise<void> {
  const state = await readStoredPerformMode(client, options);
  if (state === true) {
    throw new PreviewWithheldError(
      "Perform mode is active; preview capture skipped to avoid nonessential live-show compute.",
    );
  }
  if (state !== false) {
    throw new PreviewWithheldError(
      `Could not confirm Perform mode is off, so preview capture was skipped: ${state.unreadable}`,
    );
  }
}

type PerformModeState = boolean | { unreadable: string };

/**
 * Reads the flag `set_perform_mode` stores, not the native `ui`/`project` values.
 * Connection failures, timeouts and backpressure are rethrown so callers report them
 * as usual; a bridge that answers without giving the state comes back as `unreadable`.
 */
async function readStoredPerformMode(
  client: TouchDesignerClient,
  options?: TdReadRequestOptions,
): Promise<PerformModeState> {
  let flag: Awaited<ReturnType<TouchDesignerClient["getSystemInfo"]>>["storedPerformMode"];
  try {
    flag = (await client.getSystemInfo(["storedPerformMode"], options)).storedPerformMode;
  } catch (err) {
    if (!isMissingEndpoint(err)) {
      if (err instanceof TdApiError) return { unreadable: friendlyTdError(err) };
      throw err;
    }
  }
  if (typeof flag === "boolean") return flag;
  if (flag) return { unreadable: flag.error };
  return readStoredPerformModeViaExec(client);
}

/** Older bridges have no `storedPerformMode` section, so ask over exec. */
async function readStoredPerformModeViaExec(
  client: TouchDesignerClient,
): Promise<PerformModeState> {
  let stdout: string | undefined;
  try {
    const exec = await client.executePythonScript(
      "import json\nprint(json.dumps({'perform': bool(op('/').fetch('tdmcp_perform_mode', False))}))",
      true,
    );
    stdout = exec.stdout;
  } catch (err) {
    if (!(err instanceof TdApiError)) throw err;
    return {
      unreadable: `this bridge predates the stored flag read and refused the exec fallback (${friendlyTdError(err)}). Update the bridge with \`tdmcp install-bridge\`.`,
    };
  }
  const perform = parsePerformLine(stdout);
  return perform ?? { unreadable: "the bridge's exec reply did not include the flag." };
}

function parsePerformLine(stdout: string | undefined): boolean | undefined {
  const line = stdout?.trim().split("\n").at(-1);
  if (!line) return undefined;
  try {
    const { perform } = JSON.parse(line) as { perform?: unknown };
    return typeof perform === "boolean" ? perform : undefined;
  } catch {
    return undefined;
  }
}
