import { z } from "zod";
import { guardTd, structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const MAX_NODES = 150;

export const documentNetworkSchema = z.object({
  path: z.string().default("/project1").describe("Network root to document."),
  recursive: z
    .boolean()
    .default(false)
    .describe("Include all descendants (otherwise just the direct children)."),
});
type DocumentNetworkArgs = z.infer<typeof documentNetworkSchema>;

/** Operator family from a type like 'noiseTOP' → 'TOP'. */
function family(type: string): string {
  const m = /(TOP|CHOP|SOP|COMP|DAT|MAT|POP)$/.exec(type);
  return m?.[1] ?? "other";
}

/** Builds a Mermaid flowchart + a grouped summary from a topology. */
export function buildDocument(
  path: string,
  nodes: Array<{ path: string; type: string; name: string }>,
  connections: Array<{ source_path: string; target_path: string }>,
) {
  const truncated = nodes.length > MAX_NODES;
  const shown = nodes.slice(0, MAX_NODES);
  const id = new Map<string, string>();
  shown.forEach((n, i) => {
    id.set(n.path, `n${i}`);
  });

  const lines = ["flowchart LR"];
  for (const n of shown) {
    const label = `${n.name} (${n.type})`.replace(/"/g, "'");
    lines.push(`  ${id.get(n.path)}["${label}"]`);
  }
  for (const c of connections) {
    const from = id.get(c.source_path);
    const to = id.get(c.target_path);
    if (from && to) lines.push(`  ${from} --> ${to}`);
  }
  const mermaid = lines.join("\n");

  const byFamily: Record<string, number> = {};
  const byType: Record<string, number> = {};
  for (const n of nodes) {
    byFamily[family(n.type)] = (byFamily[family(n.type)] ?? 0) + 1;
    byType[n.type] = (byType[n.type] ?? 0) + 1;
  }
  const topTypes = Object.entries(byType)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([t, n]) => `${t}×${n}`);

  return {
    path,
    nodeCount: nodes.length,
    connectionCount: connections.length,
    families: byFamily,
    top_types: topTypes,
    truncated,
    mermaid,
  };
}

export async function documentNetworkImpl(ctx: ToolContext, args: DocumentNetworkArgs) {
  return guardTd(
    () => ctx.client.getNetworkTopology(args.path, args.recursive),
    (topology) => {
      const doc = buildDocument(args.path, topology.nodes, topology.connections);
      const summary = `${args.path}: ${doc.nodeCount} node(s), ${doc.connectionCount} connection(s) — ${doc.top_types.join(", ")}${
        doc.truncated ? ` (diagram capped at ${MAX_NODES})` : ""
      }.`;
      return structuredResult(summary, doc);
    },
  );
}

export const registerDocumentNetwork: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "document_network",
    {
      title: "Document network",
      description:
        "Document an EXISTING network: read its nodes and connections and return a readable map — counts by operator family and type, plus a Mermaid flowchart of the data flow you can paste into docs. Unlike plan_visual (which plans from a description), this describes what's actually in the project. Use it to explain or hand off a patch.",
      inputSchema: documentNetworkSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    (args) => documentNetworkImpl(ctx, args),
  );
};
