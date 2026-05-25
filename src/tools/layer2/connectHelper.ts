import type { TouchDesignerClient } from "../../td-client/touchDesignerClient.js";
import { TdApiError } from "../../td-client/types.js";

export interface ConnectResult {
  method: "batch" | "python";
}

/**
 * Connects two nodes. Prefers the bridge `/api/batch` connect op; if the bridge
 * responds with an API error (e.g. batch not supported), falls back to a Python
 * `inputConnectors[...].connect(...)` call. Connection/timeout errors propagate.
 */
export async function connectNodesViaBridge(
  client: TouchDesignerClient,
  sourcePath: string,
  targetPath: string,
  sourceOutput = 0,
  targetInput = 0,
): Promise<ConnectResult> {
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

  // Fallback: wire via Python inside TD.
  const src = JSON.stringify(sourcePath);
  const dst = JSON.stringify(targetPath);
  const python = `op(${dst}).inputConnectors[${targetInput}].connect(op(${src}).outputConnectors[${sourceOutput}])`;
  await client.executePythonScript(python, false);
  return { method: "python" };
}
