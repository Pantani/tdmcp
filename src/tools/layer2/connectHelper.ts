import type { TouchDesignerClient } from "../../td-client/touchDesignerClient.js";
import { friendlyTdError, isMissingEndpoint, TdApiError } from "../../td-client/types.js";

export interface ConnectResult {
  method: "endpoint" | "batch" | "python";
  /**
   * Present only when the bridge's `/api/batch` connect op resolved but reported
   * `ok:false` and the Python fallback then recovered. Carries that op's `error`
   * string so callers can surface *why* the faster path failed (cross-container
   * wire, missing op, …) instead of silently dropping to Python. Absent on a
   * clean batch success.
   */
  batchError?: string;
}

/**
 * Connects two nodes. Prefers the first-class `/api/connect` endpoint (which
 * survives TDMCP_BRIDGE_ALLOW_EXEC=0); on an API error (older bridge / 404) falls
 * back to the `/api/batch` connect op, then to a Python
 * `inputConnectors[...].connect(...)` call. Connection/timeout errors propagate.
 */
export async function connectNodesViaBridge(
  client: TouchDesignerClient,
  sourcePath: string,
  targetPath: string,
  sourceOutput = 0,
  targetInput = 0,
): Promise<ConnectResult> {
  // 1) first-class endpoint (survives ALLOW_EXEC=0)
  try {
    await client.connectNodes(sourcePath, targetPath, sourceOutput, targetInput);
    return { method: "endpoint" };
  } catch (err) {
    // Fall back ONLY when the endpoint is absent (older bridge). A real
    // validation rejection (e.g. cross-container wire, HTTP 400) must surface —
    // retrying via batch/python would reintroduce the old silent no-op.
    if (!isMissingEndpoint(err)) throw err;
  }

  let batchError: string | undefined;
  try {
    const result = await client.batch([
      {
        action: "connect",
        source_path: sourcePath,
        target_path: targetPath,
        source_output: sourceOutput,
        target_input: targetInput,
      },
    ]);
    const op = result.results[0];
    if (op?.ok) return { method: "batch" };
    // Batch resolved but the connect op failed inside it. Keep its reason so we
    // can surface *why* instead of silently dropping to the Python fallback.
    batchError = op?.error;
  } catch (err) {
    if (!(err instanceof TdApiError)) throw err;
  }

  // Fallback: wire via Python inside TD. Validate first so a cross-container
  // wire (which TD silently no-ops) or a missing op raises instead of reporting
  // a phantom success.
  const src = JSON.stringify(sourcePath);
  const dst = JSON.stringify(targetPath);
  const python = [
    `__s = op(${src}); __d = op(${dst})`,
    `if __s is None or __d is None: raise LookupError('connect: source or target not found (%s -> %s)' % (${src}, ${dst}))`,
    `if __s.parent() is None or __d.parent() is None or __s.parent().path != __d.parent().path: raise ValueError('connect: cannot wire across containers (%s -> %s); use a Select/In OP to bring an operator across networks' % (${src}, ${dst}))`,
    `__d.inputConnectors[${targetInput}].connect(__s.outputConnectors[${sourceOutput}])`,
  ].join("\n");
  try {
    await client.executePythonScript(python, false);
  } catch (err) {
    // Both transports failed. If the batch op had reported a reason, fold it
    // into the thrown message so the caller learns *why* the connect failed —
    // not just that the Python fallback did.
    if (batchError) {
      throw new TdApiError(`${friendlyTdError(err)} (batch connect also failed: ${batchError})`, {
        cause: err,
      });
    }
    throw err;
  }
  return batchError ? { method: "python", batchError } : { method: "python" };
}
