import { basename, extname } from "node:path";
import { z } from "zod";
import { Vault } from "../../vault/index.js";
import { type errorResult, structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { readNoteSafe, requireVault } from "./shared.js";

export const libraryLineageGraphSchema = z.object({
  vault_path: z
    .string()
    .optional()
    .describe("Absolute path override; falls back to TDMCP_VAULT_PATH."),
  format: z.enum(["json", "mermaid", "dot"]).default("json").describe("Output format."),
  kinds: z
    .array(z.enum(["recipes", "shaders", "presets", "components", "setlists", "all"]))
    .default(["all"])
    .describe("Categories to scan. 'all' includes every category."),
  cluster_by: z
    .enum(["none", "style_tags", "mood", "author", "difficulty"])
    .default("style_tags")
    .describe("Grouping for Mermaid subgraph / DOT cluster."),
  include_orphans: z
    .boolean()
    .default(true)
    .describe("When false, exclude nodes with no lineage edges."),
  max_nodes: z
    .number()
    .int()
    .min(1)
    .max(2000)
    .default(500)
    .describe("Safety cap on nodes returned."),
});

type LibraryLineageGraphArgs = z.infer<typeof libraryLineageGraphSchema>;

type LineageNode = {
  id: string;
  title: string;
  kind: "recipes" | "shaders" | "presets" | "components" | "setlists";
  path: string;
  tags: string[];
  style_tags: string[];
  mood: string | null;
  author: string | null;
  difficulty: "beginner" | "intermediate" | "advanced" | null;
  description: string | null;
  created_at: string | null;
};

type LineageEdge = {
  from: string;
  to: string;
  relation: "parent_recipe" | "source_asset" | "remix_of" | "forked_from";
  match: "path" | "title" | "id" | "unresolved";
};

type Cluster = {
  key: string;
  by: "style_tags" | "mood" | "author" | "difficulty";
  members: string[];
};

type LineageGraph = {
  vault_path: string;
  generated_at: string;
  nodes: LineageNode[];
  edges: LineageEdge[];
  clusters: Cluster[];
  contributors: Array<{ author: string; count: number; assets: string[] }>;
  warnings: string[];
  counts: { nodes: number; edges: number; orphans: number; unresolved_edges: number };
};

const CATEGORY_FOLDERS: Record<string, string> = {
  recipes: "Recipes",
  shaders: "Shaders",
  presets: "Presets",
  components: "Components",
  setlists: "Setlists",
};

const KIND_PREFIX: Record<string, string> = {
  recipes: "R_",
  shaders: "S_",
  presets: "P_",
  components: "C_",
  setlists: "L_",
};

const ALL_KINDS = Object.keys(CATEGORY_FOLDERS) as Array<
  "recipes" | "shaders" | "presets" | "components" | "setlists"
>;

// Kind priority for title-resolution tie-breaking
const KIND_PRIORITY: Array<"recipes" | "shaders" | "presets" | "components" | "setlists"> = [
  "recipes",
  "components",
  "shaders",
  "presets",
  "setlists",
];

function fmString(data: Record<string, unknown>, key: string): string | undefined {
  const v = data[key];
  return typeof v === "string" ? v : undefined;
}

function fmTags(data: Record<string, unknown>, key = "tags"): string[] {
  const v = data[key];
  if (Array.isArray(v)) return v.map((t) => String(t)).filter(Boolean);
  if (typeof v === "string")
    return v
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  return [];
}

function fmStrings(data: Record<string, unknown>, key: string): string[] {
  const v = data[key];
  if (Array.isArray(v)) return v.map((t) => String(t)).filter(Boolean);
  if (typeof v === "string") return [v];
  return [];
}

function firstBodyLine(body: string): string | undefined {
  for (const line of body.split("\n")) {
    const t = line.replace(/^#+\s*/, "").trim();
    if (t) return t;
  }
  return undefined;
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

function mermaidEscape(s: string): string {
  return s.replace(/"/g, "&quot;").replace(/\[/g, "(").replace(/\]/g, ")");
}

function buildMermaidId(kind: string, nodePath: string, seen: Map<string, string>): string {
  const prefix = KIND_PREFIX[kind] ?? "X_";
  const stem = slug(basename(nodePath, extname(nodePath)));
  let candidate = `${prefix}${stem}`;
  let n = 1;
  while ([...seen.values()].includes(candidate)) {
    candidate = `${prefix}${stem}_${n++}`;
  }
  seen.set(nodePath, candidate);
  return candidate;
}

function renderMermaid(graph: LineageGraph, clusterBy: string): string {
  const lines: string[] = ["graph LR"];
  const mermaidIds = new Map<string, string>();

  // Build mermaid ids for all real nodes
  for (const node of graph.nodes) {
    buildMermaidId(node.kind, node.path, mermaidIds);
  }

  // Add unresolved stub if needed
  const unresolvedEdges = graph.edges.filter((e) => e.match === "unresolved");
  const unresolvedTargets = new Set(unresolvedEdges.map((e) => e.to));

  // Clusters / subgraphs
  if (clusterBy !== "none") {
    for (const cluster of graph.clusters) {
      lines.push(`  subgraph ${mermaidEscape(cluster.key)}`);
      for (const memberId of cluster.members) {
        const mid = mermaidIds.get(memberId);
        const node = graph.nodes.find((n) => n.id === memberId);
        if (mid && node) {
          lines.push(`    ${mid}["${mermaidEscape(node.title)}"]`);
        }
      }
      lines.push("  end");
    }

    // Nodes not in any cluster
    const clusteredIds = new Set(graph.clusters.flatMap((c) => c.members));
    for (const node of graph.nodes) {
      if (!clusteredIds.has(node.id)) {
        const mid = mermaidIds.get(node.path);
        if (mid) {
          lines.push(`  ${mid}["${mermaidEscape(node.title)}"]`);
        }
      }
    }
  } else {
    for (const node of graph.nodes) {
      const mid = mermaidIds.get(node.path);
      if (mid) {
        lines.push(`  ${mid}["${mermaidEscape(node.title)}"]`);
      }
    }
  }

  // Unresolved stub node
  if (unresolvedTargets.size > 0) {
    lines.push(`  UNRESOLVED["???[unresolved]"]:::unresolved`);
    lines.push("  classDef unresolved fill:#fcc,stroke:#f00;");
  }

  // Edges
  for (const edge of graph.edges) {
    const fromMid = mermaidIds.get(edge.from);
    const toNode = graph.nodes.find((n) => n.id === edge.to);
    const toMid = toNode ? mermaidIds.get(toNode.path) : undefined;
    const targetMid = edge.match === "unresolved" ? "UNRESOLVED" : toMid;
    if (!fromMid || !targetMid) continue;
    const arrow =
      edge.relation === "source_asset" ? `-.->|${edge.relation}|` : `-->|${edge.relation}|`;
    lines.push(`  ${fromMid} ${arrow} ${targetMid}`);
  }

  return lines.join("\n");
}

function renderDot(graph: LineageGraph, clusterBy: string): string {
  const lines: string[] = [
    "digraph lineage {",
    "  rankdir=LR;",
    "  node [shape=box, style=rounded];",
  ];

  if (clusterBy !== "none") {
    for (const cluster of graph.clusters) {
      const cSlug = slug(cluster.key);
      lines.push(`  subgraph cluster_${cSlug} {`);
      lines.push(`    label="${cluster.key}";`);
      for (const memberId of cluster.members) {
        const node = graph.nodes.find((n) => n.id === memberId);
        if (node) {
          lines.push(`    "${node.path}" [label="${node.title.replace(/"/g, '\\"')}"];`);
        }
      }
      lines.push("  }");
    }
  } else {
    for (const node of graph.nodes) {
      lines.push(`  "${node.path}" [label="${node.title.replace(/"/g, '\\"')}"];`);
    }
  }

  for (const edge of graph.edges) {
    const toPath = edge.match === "unresolved" ? "???" : edge.to;
    const style = edge.relation === "source_asset" ? ", style=dashed" : "";
    lines.push(`  "${edge.from}" -> "${toPath}" [label="${edge.relation}"${style}];`);
  }

  lines.push("}");
  return lines.join("\n");
}

function buildClusters(
  nodes: LineageNode[],
  clusterBy: "none" | "style_tags" | "mood" | "author" | "difficulty",
): Cluster[] {
  if (clusterBy === "none") return [];

  const map = new Map<string, string[]>();

  for (const node of nodes) {
    let keys: string[] = [];
    if (clusterBy === "style_tags") {
      keys = node.style_tags.length > 0 ? node.style_tags : [];
    } else if (clusterBy === "mood") {
      keys = node.mood ? [node.mood] : [];
    } else if (clusterBy === "author") {
      keys = node.author ? [node.author] : [];
    } else if (clusterBy === "difficulty") {
      keys = node.difficulty ? [node.difficulty] : [];
    }

    for (const key of keys) {
      const existing = map.get(key) ?? [];
      existing.push(node.id);
      map.set(key, existing);
    }
  }

  return [...map.entries()].map(([key, members]) => ({
    key,
    by: clusterBy as "style_tags" | "mood" | "author" | "difficulty",
    members,
  }));
}

export async function libraryLineageGraphImpl(
  ctx: ToolContext,
  args: LibraryLineageGraphArgs,
): Promise<ReturnType<typeof structuredResult | typeof errorResult>> {
  // Resolve vault
  let vault: Vault;
  if (args.vault_path) {
    vault = new Vault(args.vault_path);
  } else {
    const v = requireVault(ctx);
    if ("error" in v) return v.error;
    vault = v.vault;
  }

  const requested = args.kinds.includes("all")
    ? ALL_KINDS
    : ([...new Set(args.kinds)].filter((k) => k !== "all") as Array<
        "recipes" | "shaders" | "presets" | "components" | "setlists"
      >);

  const rawNodes: LineageNode[] = [];
  const warnings: string[] = [];

  // Collect file mtimes for max_nodes truncation (newest first)
  const nodeWithMtime: Array<{ node: LineageNode; mtime: number }> = [];

  for (const kind of requested) {
    const folder = CATEGORY_FOLDERS[kind];
    if (!folder) continue;

    const files = vault.list(folder, ".md");

    for (const filename of files) {
      const relPath = `${folder}/${filename}`;
      const noteResult = readNoteSafe(vault, relPath);
      if ("error" in noteResult) {
        warnings.push(`Could not read ${relPath}: skipped.`);
        continue;
      }
      const { data, body } = noteResult;

      const stem = basename(filename, extname(filename));
      const title = fmString(data, "title") ?? fmString(data, "name") ?? stem;
      const tags = fmTags(data, "tags");
      const rawStyleTags = fmTags(data, "style_tags");
      const style_tags = rawStyleTags.length > 0 ? rawStyleTags : [];
      const mood = fmString(data, "mood") ?? null;
      const author = fmString(data, "author") ?? fmString(data, "contributor") ?? null;
      const rawDiff = fmString(data, "difficulty");
      const difficulty =
        rawDiff === "beginner" || rawDiff === "intermediate" || rawDiff === "advanced"
          ? rawDiff
          : null;
      const description =
        fmString(data, "description") ?? fmString(data, "desc") ?? firstBodyLine(body) ?? null;
      const created_at = fmString(data, "created_at") ?? null;

      const node: LineageNode = {
        id: relPath,
        title,
        kind,
        path: relPath,
        tags,
        style_tags,
        mood,
        author,
        difficulty,
        description,
        created_at,
      };

      // Get mtime for sorting
      let mtime = 0;
      try {
        const { statSync } = await import("node:fs");
        mtime = statSync(vault.resolve(relPath)).mtimeMs;
      } catch {
        mtime = 0;
      }

      nodeWithMtime.push({ node, mtime });
    }
  }

  // Sort newest first, apply max_nodes cap
  nodeWithMtime.sort((a, b) => b.mtime - a.mtime);
  if (nodeWithMtime.length > args.max_nodes) {
    warnings.push(
      `Truncated to ${args.max_nodes} nodes (${nodeWithMtime.length} total); oldest nodes dropped.`,
    );
    nodeWithMtime.splice(args.max_nodes);
  }

  for (const { node } of nodeWithMtime) {
    rawNodes.push(node);
  }

  // Build path and title indexes
  const pathIndex = new Map<string, LineageNode>();
  for (const node of rawNodes) {
    pathIndex.set(node.id, node);
  }

  // Title index: sorted by kind priority for tie-breaking
  const titleIndex = new Map<string, string>(); // titleLower → node.id
  for (const priority of KIND_PRIORITY) {
    for (const node of rawNodes) {
      if (node.kind !== priority) continue;
      const key = node.title.toLowerCase();
      if (!titleIndex.has(key)) {
        titleIndex.set(key, node.id);
      }
    }
  }

  // Build edges
  const edges: LineageEdge[] = [];
  const edgeKeys = new Set<string>();

  function addEdge(from: string, ref: string, relation: LineageEdge["relation"]): void {
    if (!ref) return;

    let to: string;
    let match: LineageEdge["match"];

    if (pathIndex.has(ref)) {
      to = ref;
      match = "path";
    } else {
      const byTitle = titleIndex.get(ref.toLowerCase());
      if (byTitle) {
        to = byTitle;
        match = "title";
      } else {
        to = ref;
        match = "unresolved";
        warnings.push(`Unresolved ${relation} ref "${ref}" from "${from}".`);
      }
    }

    if (to === from) return; // skip self-edges
    const key = `${from}→${to}→${relation}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ from, to, relation, match });
  }

  for (const node of rawNodes) {
    const noteResult = readNoteSafe(vault, node.path);
    if ("error" in noteResult) continue;
    const { data } = noteResult;

    const parentRecipe = fmString(data, "parent_recipe");
    if (parentRecipe) addEdge(node.id, parentRecipe, "parent_recipe");

    const sourceAssets = fmStrings(data, "source_assets");
    for (const sa of sourceAssets) {
      addEdge(node.id, sa, "source_asset");
    }

    const remixOf = fmString(data, "remix_of");
    if (remixOf) addEdge(node.id, remixOf, "remix_of");

    const forkedFrom = fmString(data, "forked_from");
    if (forkedFrom) addEdge(node.id, forkedFrom, "forked_from");
  }

  // Filter orphans if requested
  let nodes = rawNodes;
  if (!args.include_orphans) {
    const connectedIds = new Set<string>();
    for (const edge of edges) {
      connectedIds.add(edge.from);
      if (pathIndex.has(edge.to)) connectedIds.add(edge.to);
    }
    nodes = rawNodes.filter((n) => connectedIds.has(n.id));
  }

  const orphanCount = rawNodes.filter((n) => {
    return !edges.some((e) => e.from === n.id || e.to === n.id);
  }).length;

  const unresolvedCount = edges.filter((e) => e.match === "unresolved").length;

  // Clusters
  const clusters = buildClusters(nodes, args.cluster_by);

  // Contributors
  const contribMap = new Map<string, string[]>();
  for (const node of nodes) {
    if (!node.author) continue;
    const existing = contribMap.get(node.author) ?? [];
    existing.push(node.id);
    contribMap.set(node.author, existing);
  }
  const contributors = [...contribMap.entries()]
    .map(([author, assets]) => ({ author, count: assets.length, assets }))
    .sort((a, b) => b.count - a.count);

  const graph: LineageGraph = {
    vault_path: vault.root,
    generated_at: new Date().toISOString(),
    nodes,
    edges,
    clusters,
    contributors,
    warnings,
    counts: {
      nodes: nodes.length,
      edges: edges.length,
      orphans: orphanCount,
      unresolved_edges: unresolvedCount,
    },
  };

  if (nodes.length === 0) {
    return structuredResult(
      "No lineage data found in the vault for the requested categories.",
      graph,
    );
  }

  if (args.format === "json") {
    return structuredResult(
      `Lineage graph: ${nodes.length} nodes, ${edges.length} edges across the vault.`,
      graph,
    );
  }

  if (args.format === "mermaid") {
    const rendered = renderMermaid(graph, args.cluster_by);
    return structuredResult(rendered, graph);
  }

  // dot
  const rendered = renderDot(graph, args.cluster_by);
  return structuredResult(rendered, graph);
}

export const registerLibraryLineageGraph: ToolRegistrar = (server, ctx) =>
  server.registerTool(
    "library_lineage_graph",
    {
      title: "Library lineage graph",
      description:
        "Read-only, offline tool that scans the vault library (Recipes, Shaders, Presets, Components, Setlists), extracts lineage frontmatter (parent_recipe, source_assets, remix_of, forked_from), and emits a lineage graph. Output as JSON (machine-consumable), Mermaid (paste into docs), or Graphviz DOT. No TouchDesigner connection required.",
      inputSchema: libraryLineageGraphSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    (args) => libraryLineageGraphImpl(ctx, args),
  );
