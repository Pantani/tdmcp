/**
 * Creative RAG — map a download's Content-Type header to a file extension.
 *
 * `downloadBinary` used to hardcode `.jpg` for every saved image. This helper
 * picks the right extension from the response's `Content-Type` so a PNG/WebP/GIF
 * is stored with its true extension. Matching is case-insensitive and any
 * parameters after `;` (e.g. `; charset=utf-8`) are stripped. An unknown,
 * missing, null, or undefined type falls back to `.jpg`.
 */

const CONTENT_TYPE_TO_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/tiff": ".tif",
  "image/svg+xml": ".svg",
};

const FALLBACK_EXT = ".jpg";

/** Map a Content-Type header (or undefined) to a file extension incl. leading dot. */
export function extensionForContentType(contentType: string | null | undefined): string {
  if (!contentType) {
    return FALLBACK_EXT;
  }
  const mime = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return CONTENT_TYPE_TO_EXT[mime] ?? FALLBACK_EXT;
}
