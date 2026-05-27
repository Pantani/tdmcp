import { z } from "zod";
import { buildDocument } from "../layer3/documentNetwork.js";
import { guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { requireVault } from "./shared.js";

export const exportNetworkToVaultSchema = z.object({
  path: z.string().default("/project1").describe("Network root to document."),
  recursive: z
    .boolean()
    .default(false)
    .describe("Include all descendants (otherwise just the direct children)."),
  note: z.string().optional().describe("Vault note path (defaults to Networks/<path>.md)."),
});
type ExportNetworkToVaultArgs = z.infer<typeof exportNetworkToVaultSchema>;

const FAMILY = /(TOP|CHOP|SOP|COMP|DAT|MAT|POP)$/;
function family(type: string): string {
  return FAMILY.exec(type)?.[1] ?? "other";
}

function slugPath(p: string): string {
  return p.replace(/^\//, "").replace(/[^a-zA-Z0-9._-]+/g, "_") || "project";
}

export async function exportNetworkToVaultImpl(ctx: ToolContext, args: ExportNetworkToVaultArgs) {
  const v = requireVault(ctx);
  if ("error" in v) return v.error;
  const { vault } = v;

  const rel = args.note
    ? args.note.endsWith(".md")
      ? args.note
      : `${args.note}.md`
    : `Networks/${slugPath(args.path)}.md`;

  return guardTd(
    () => ctx.client.getNetworkTopology(args.path, args.recursive),
    (topology) => {
      const doc = buildDocument(args.path, topology.nodes, topology.connections);
      const nameByPath = new Map(topology.nodes.map((n): [string, string] => [n.path, n.name]));

      // Group operators by family; each is a [[wikilink]] so the vault graph view
      // connects this network note to a node per operator.
      const groups = new Map<string, string[]>();
      for (const n of topology.nodes) {
        const list = groups.get(family(n.type)) ?? [];
        list.push(`- [[${n.name}]] · \`${n.type}\``);
        groups.set(family(n.type), list);
      }
      const opsSection = [...groups.entries()]
        .map(([fam, items]) => `### ${fam}\n${items.join("\n")}`)
        .join("\n\n");

      const conns = topology.connections
        .map((c) => {
          const from = nameByPath.get(c.source_path);
          const to = nameByPath.get(c.target_path);
          return from && to ? `- [[${from}]] → [[${to}]]` : undefined;
        })
        .filter((line): line is string => Boolean(line));

      const body =
        `Network map of \`${args.path}\` — ${doc.nodeCount} operator(s), ${doc.connectionCount} connection(s).\n\n` +
        `## Diagram\n\n\`\`\`mermaid\n${doc.mermaid}\n\`\`\`\n\n` +
        `## Operators\n\n${opsSection || "_none_"}\n\n` +
        `## Connections\n\n${conns.join("\n") || "_none_"}\n`;

      vault.writeNote(
        rel,
        {
          path: args.path,
          type: "tdmcp-network",
          nodes: doc.nodeCount,
          connections: doc.connectionCount,
          families: doc.families,
          captured: new Date().toISOString(),
        },
        body,
      );

      return jsonResult(
        `Documented ${args.path} to ${rel} (${doc.nodeCount} node(s), ${doc.connectionCount} connection(s)).`,
        {
          path: rel,
          nodes: doc.nodeCount,
          connections: doc.connectionCount,
          truncated: doc.truncated,
        },
      );
    },
  );
}

export const registerExportNetworkToVault: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "export_network_to_vault",
    {
      title: "Export network docs to the vault",
      description:
        "Document an existing TD network into an Obsidian note: a Mermaid flowchart plus [[wikilinks]] for every operator and connection, so the vault's graph view becomes a clickable map of the patch. Requires TDMCP_VAULT_PATH.",
      inputSchema: exportNetworkToVaultSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => exportNetworkToVaultImpl(ctx, args),
  );
};
