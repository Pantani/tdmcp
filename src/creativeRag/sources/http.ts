/**
 * Shared timeout guard for source HTTP calls. Every external museum fetch goes
 * through here so a hung upstream host can never stall the whole `sync` path: an
 * {@link AbortController} aborts the request after `timeoutMs` and the abort is
 * reported as a clear, labelled error (which per-item loops catch and skip).
 */

const DEFAULT_TIMEOUT_MS = 15000;

export async function fetchWithTimeout(
  url: string,
  fetchImpl: typeof fetch,
  label: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`${label} timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
