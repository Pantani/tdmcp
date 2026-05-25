import type { TouchDesignerClient } from "../td-client/touchDesignerClient.js";
import type { TdTopology } from "../td-client/types.js";

export interface VerifyReport {
  path: string;
  nodeCount: number;
  connectionCount: number;
  issues: string[];
  topology: TdTopology;
}

/** Inspects the topology under `path` and flags obvious structural issues. */
export async function verifyNetwork(
  client: TouchDesignerClient,
  path: string,
): Promise<VerifyReport> {
  const topology = await client.getNetworkTopology(path);
  const issues: string[] = [];
  if (topology.nodes.length === 0) {
    issues.push(`No nodes were found under ${path}.`);
  } else if (topology.nodes.length > 1 && topology.connections.length === 0) {
    issues.push("Multiple nodes exist but none are connected.");
  }
  return {
    path,
    nodeCount: topology.nodes.length,
    connectionCount: topology.connections.length,
    issues,
    topology,
  };
}
