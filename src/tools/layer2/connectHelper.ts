import type { TouchDesignerClient } from "../../td-client/touchDesignerClient.js";
import { TdApiError } from "../../td-client/types.js";

export interface ConnectResult {
  method: "endpoint" | "batch" | "python";
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
    if (!(err instanceof TdApiError)) throw err; // connection/timeout propagate
    // older bridge (404/unsupported) -> fall through to batch/python
  }

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
    if (result.results[0]?.ok) return { method: "batch" };
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
  await client.executePythonScript(python, false);
  return { method: "python" };
}
