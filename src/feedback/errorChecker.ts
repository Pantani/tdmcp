import type { TouchDesignerClient } from "../td-client/touchDesignerClient.js";
import type { TdNodeError } from "../td-client/types.js";

export interface ErrorReport {
  path: string;
  hasErrors: boolean;
  errors: TdNodeError[];
}

/** Checks a node (or its whole sub-network) for errors after building. */
export async function checkErrors(
  client: TouchDesignerClient,
  path: string,
  recursive = true,
): Promise<ErrorReport> {
  const result = recursive ? await client.getNetworkErrors(path) : await client.getNodeErrors(path);
  return { path, hasErrors: result.errors.length > 0, errors: result.errors };
}
