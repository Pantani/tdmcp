import type { TouchDesignerClient } from "../td-client/touchDesignerClient.js";
import { TdApiError } from "../td-client/types.js";

export interface PreviewResult {
  path: string;
  width: number;
  height: number;
  base64: string;
  mimeType: string;
}

/** Captures a TOP as a base64 image via the bridge preview endpoint. */
export async function capturePreview(
  client: TouchDesignerClient,
  path: string,
  width = 640,
  height = 360,
): Promise<PreviewResult> {
  if (await isPerformModeActive(client)) {
    throw new TdApiError(
      "Perform mode is active; preview capture skipped to avoid nonessential live-show compute.",
    );
  }
  const preview = await client.getPreview(path, width, height);
  return {
    path: preview.path,
    width: preview.width,
    height: preview.height,
    base64: preview.base64,
    mimeType: `image/${preview.format || "png"}`,
  };
}

async function isPerformModeActive(client: TouchDesignerClient): Promise<boolean> {
  try {
    const exec = await client.executePythonScript(
      "import json\nprint(json.dumps({'perform': bool(op('/').fetch('tdmcp_perform_mode', False))}))",
      true,
    );
    const line = exec.stdout?.trim().split("\n").at(-1);
    if (!line) return false;
    const parsed = JSON.parse(line) as { perform?: unknown };
    return parsed.perform === true;
  } catch {
    return false;
  }
}
