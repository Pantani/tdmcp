import type { TouchDesignerClient } from "../td-client/touchDesignerClient.js";

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
  const preview = await client.getPreview(path, width, height);
  return {
    path: preview.path,
    width: preview.width,
    height: preview.height,
    base64: preview.base64,
    mimeType: `image/${preview.format || "png"}`,
  };
}
