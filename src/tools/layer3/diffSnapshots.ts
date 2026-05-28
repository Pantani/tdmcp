import { z } from "zod";
import { structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const snapshotNodeSchema = z.object({
  path: z.string(),
  type: z.string().optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
});
const snapshotConnSchema = z.object({
  source_path: z.string(),
  source_output: z.number().optional(),
  target_path: z.string(),
  target_input: z.number().optional(),
});
const snapshotSchema = z.object({
  nodes: z.array(snapshotNodeSchema).default([]),
  connections: z.array(snapshotConnSchema).default([]),
});

export const diffSnapshotsSchema = z.object({
  before: snapshotSchema.describe(
    "Earlier snapshot (from snapshot_td_graph, include_params for param diffs).",
  ),
  after: snapshotSchema.describe("Later snapshot to compare against."),
});
type DiffSnapshotsArgs = z.infer<typeof diffSnapshotsSchema>;

type Snapshot = z.infer<typeof snapshotSchema>;
const connKey = (c: z.infer<typeof snapshotConnSchema>): string =>
  `${c.source_path}:${c.source_output ?? 0} -> ${c.target_path}:${c.target_input ?? 0}`;

export function diffSnapshots(before: Snapshot, after: Snapshot) {
  const beforeNodes = new Map(before.nodes.map((n) => [n.path, n]));
  const afterNodes = new Map(after.nodes.map((n) => [n.path, n]));

  const added = after.nodes.filter((n) => !beforeNodes.has(n.path)).map((n) => n.path);
  const removed = before.nodes.filter((n) => !afterNodes.has(n.path)).map((n) => n.path);

  const paramChanges: Array<{
    path: string;
    changes: Record<string, { from: unknown; to: unknown }>;
  }> = [];
  for (const [path, a] of afterNodes) {
    const b = beforeNodes.get(path);
    if (!b?.parameters || !a.parameters) continue;
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const [key, toVal] of Object.entries(a.parameters)) {
      const fromVal = b.parameters[key];
      if (JSON.stringify(fromVal) !== JSON.stringify(toVal))
        changes[key] = { from: fromVal, to: toVal };
    }
    if (Object.keys(changes).length > 0) paramChanges.push({ path, changes });
  }

  const beforeConns = new Set(before.connections.map(connKey));
  const afterConns = new Set(after.connections.map(connKey));
  const connectionsAdded = [...afterConns].filter((c) => !beforeConns.has(c));
  const connectionsRemoved = [...beforeConns].filter((c) => !afterConns.has(c));

  return {
    nodes_added: added,
    nodes_removed: removed,
    parameter_changes: paramChanges,
    connections_added: connectionsAdded,
    connections_removed: connectionsRemoved,
    unchanged:
      added.length + removed.length + paramChanges.length === 0 &&
      connectionsAdded.length + connectionsRemoved.length === 0,
  };
}

export function diffSnapshotsImpl(_ctx: ToolContext, args: DiffSnapshotsArgs) {
  const diff = diffSnapshots(args.before, args.after);
  const summary = diff.unchanged
    ? "No differences between the two snapshots."
    : `Diff: +${diff.nodes_added.length} / -${diff.nodes_removed.length} node(s), ${diff.parameter_changes.length} node(s) with parameter changes, +${diff.connections_added.length} / -${diff.connections_removed.length} connection(s).`;
  return structuredResult(summary, diff);
}

export const registerDiffSnapshots: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "diff_snapshots",
    {
      title: "Diff snapshots",
      description:
        "Compare two network snapshots (from snapshot_td_graph) and return a readable diff: which nodes were added or removed, which connections changed, and which parameters changed (with before/after values). Snapshot before an edit and after to see exactly what changed, or to version a patch over time. Pure analysis — touches nothing in TouchDesigner.",
      inputSchema: diffSnapshotsSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    (args) => diffSnapshotsImpl(ctx, args),
  );
};
