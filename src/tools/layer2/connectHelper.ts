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
