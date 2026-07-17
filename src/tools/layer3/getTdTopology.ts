import { z } from "zod";
import { verifyNetwork } from "../../feedback/networkVerifier.js";
import { TopologySchema } from "../../td-client/validators.js";
import { guardTd, structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const getTdTopologySchema = z.object({
  root_path: z.string().default("/project1").describe("Network root to map."),
});
type GetTdTopologyArgs = z.infer<typeof getTdTopologySchema>;

export const getTdTopologyOutputSchema = z.object({
  path: z.string().describe("The network root that was mapped, echoing the request."),
  nodeCount: z.number().describe("Total number of nodes found under the root."),
  connectionCount: z.number().describe("Total number of wires (connections) between those nodes."),
  issues: z
    .array(z.string())
    .describe("Plain-language structural problems detected, e.g. dangling or orphaned nodes."),
  topology: TopologySchema.describe("The full graph: the node list and the connection list."),
  topological_order: z
    .array(z.string())
    .describe("Every declared node path exactly once in deterministic signal-flow order."),
  cycle_members: z
    .array(z.string())
    .describe("Sorted node paths that belong to a multi-node cycle or a self-loop."),
  has_cycles: z.boolean().describe("Whether cycle_members is non-empty."),
});

type Topology = z.infer<typeof TopologySchema>;

function signalFlowOrder(topology: Topology) {
  const paths = [...new Set(topology.nodes.map((node) => node.path))].sort();
  const known = new Set(paths);
  const adjacency = new Map(paths.map((path) => [path, new Set<string>()]));
  for (const connection of topology.connections) {
    if (known.has(connection.source_path) && known.has(connection.target_path)) {
      adjacency.get(connection.source_path)?.add(connection.target_path);
    }
  }

  let nextIndex = 0;
  const indexes = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];

  const visit = (path: string) => {
    indexes.set(path, nextIndex);
    lowLinks.set(path, nextIndex);
    nextIndex += 1;
    stack.push(path);
    onStack.add(path);

    for (const target of [...(adjacency.get(path) ?? [])].sort()) {
      if (!indexes.has(target)) {
        visit(target);
        lowLinks.set(path, Math.min(lowLinks.get(path) ?? 0, lowLinks.get(target) ?? 0));
      } else if (onStack.has(target)) {
        lowLinks.set(path, Math.min(lowLinks.get(path) ?? 0, indexes.get(target) ?? 0));
      }
    }

    if (lowLinks.get(path) !== indexes.get(path)) return;
    const component: string[] = [];
    while (stack.length > 0) {
      const member = stack.pop();
      if (member === undefined) break;
      onStack.delete(member);
      component.push(member);
      if (member === path) break;
    }
    components.push(component.sort());
  };

  for (const path of paths) {
    if (!indexes.has(path)) visit(path);
  }

  const componentByPath = new Map<string, number>();
  components.forEach((component, index) => {
    for (const path of component) componentByPath.set(path, index);
  });
  const componentEdges = components.map(() => new Set<number>());
  const indegree = components.map(() => 0);
  for (const [source, targets] of adjacency) {
    const sourceComponent = componentByPath.get(source);
    if (sourceComponent === undefined) continue;
    for (const target of targets) {
      const targetComponent = componentByPath.get(target);
      if (
        targetComponent === undefined ||
        targetComponent === sourceComponent ||
        componentEdges[sourceComponent]?.has(targetComponent)
      ) {
        continue;
      }
      componentEdges[sourceComponent]?.add(targetComponent);
      indegree[targetComponent] = (indegree[targetComponent] ?? 0) + 1;
    }
  }

  const componentKey = (index: number) => components[index]?.[0] ?? "";
  const ready = components
    .map((_, index) => index)
    .filter((index) => indegree[index] === 0)
    .sort((left, right) => componentKey(left).localeCompare(componentKey(right)));
  const orderedComponents: number[] = [];
  while (ready.length > 0) {
    const current = ready.shift();
    if (current === undefined) break;
    orderedComponents.push(current);
    for (const target of [...(componentEdges[current] ?? [])].sort((left, right) =>
      componentKey(left).localeCompare(componentKey(right)),
    )) {
      indegree[target] = (indegree[target] ?? 0) - 1;
      if (indegree[target] === 0) {
        ready.push(target);
        ready.sort((left, right) => componentKey(left).localeCompare(componentKey(right)));
      }
    }
  }

  const cycleMembers = components
    .filter(
      (component) =>
        component.length > 1 ||
        (component[0] !== undefined && adjacency.get(component[0])?.has(component[0])),
    )
    .flat()
    .sort();
  return {
    topological_order: orderedComponents.flatMap((index) => components[index] ?? []),
    cycle_members: cycleMembers,
    has_cycles: cycleMembers.length > 0,
  };
}

export async function getTdTopologyImpl(ctx: ToolContext, args: GetTdTopologyArgs) {
  return guardTd(
    () => verifyNetwork(ctx.client, args.root_path),
    (report) => {
      const flow = signalFlowOrder(report.topology);
      return structuredResult(
        `${report.nodeCount} node(s), ${report.connectionCount} connection(s) under ${args.root_path}.`,
        { ...report, ...flow },
      );
    },
  );
}

export const registerGetTdTopology: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "get_td_topology",
    {
      title: "Get network topology",
      description:
        "Read-only: return the nodes AND the connections (wiring) under a network root, flagging obvious structural issues. Returns {nodeCount, connectionCount, issues[], topology}. Use this when you need how nodes are wired together; use get_td_nodes/find_td_nodes when you only need the node list without connections, or snapshot_td_graph when you also want each node's parameters captured for diffing. Token economy: point it at a specific network root rather than the project root, and leave recursion off unless you need nested networks.",
      inputSchema: getTdTopologySchema.shape,
      outputSchema: getTdTopologyOutputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    (args) => getTdTopologyImpl(ctx, args),
  );
};
