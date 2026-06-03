import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TouchDesignerClient } from "../td-client/touchDesignerClient.js";
import { TdConnectionError } from "../td-client/types.js";
import { familyOf } from "./familyOf.js";
import { groupErrors } from "./sceneSummary.js";
import { firstVar, jsonContents, type ResourceRegistrar } from "./shared.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const GraphDigestFamilySchema = z.object({
  count: z.number(),
  topTypes: z.array(z.object({ type: z.string(), count: z.number() })),
});

export const GraphDigestSchema = z.object({
  path: z.string(),
  header: z.string(),
  nodeCount: z.number(),
  connectionCount: z.number(),
  primaryOutput: z.object({ path: z.string(), type: z.string() }).nullable(),
  families: z.record(z.string(), GraphDigestFamilySchema),
  outputChain: z.array(z.object({ path: z.string(), type: z.string() })),
  errors: z.object({
    total: z.number(),
    topGroups: z.array(z.object({ key: z.string(), count: z.number() })),
  }),
  warnings: z.array(z.string()),
  approxTokens: z.number(),
  cachedAt: z.string(),
  overBudget: z.boolean().optional(),
});
export type GraphDigest = z.infer<typeof GraphDigestSchema>;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface BuildDigestOptions {
  maxTokens: number;
  includeErrors: boolean;
  includeOutputChain: boolean;
  outputChainDepth: number;
  familyTopTypes: number;
}

export const DEFAULT_DIGEST_OPTIONS: BuildDigestOptions = {
  maxTokens: 500,
  includeErrors: true,
  includeOutputChain: true,
  outputChainDepth: 6,
  familyTopTypes: 3,
};

// ---------------------------------------------------------------------------
// Cache (5 s hot / 1 s offline) keyed by all opts, scoped per-client.
// ---------------------------------------------------------------------------

type DigestCacheEntry = { expires: number; payload: GraphDigest };
let cache = new WeakMap<TouchDesignerClient, Map<string, DigestCacheEntry>>();
const TTL_MS = 5_000;
const OFFLINE_TTL_MS = 1_000;

function cacheKey(root: string, opts: BuildDigestOptions): string {
  return [
    root,
    opts.maxTokens,
    opts.includeErrors ? 1 : 0,
    opts.includeOutputChain ? 1 : 0,
    opts.outputChainDepth,
    opts.familyTopTypes,
  ].join("|");
}

function getCached(
  client: TouchDesignerClient,
  root: string,
  opts: BuildDigestOptions,
): GraphDigest | undefined {
  const perClient = cache.get(client);
  if (!perClient) return undefined;
  const key = cacheKey(root, opts);
  const entry = perClient.get(key);
  if (entry && Date.now() < entry.expires) return entry.payload;
  if (entry) perClient.delete(key);
  return undefined;
}

function setCached(
  client: TouchDesignerClient,
  root: string,
  opts: BuildDigestOptions,
  payload: GraphDigest,
  offline: boolean,
): void {
  let perClient = cache.get(client);
  if (!perClient) {
    perClient = new Map<string, DigestCacheEntry>();
    cache.set(client, perClient);
  }
  perClient.set(cacheKey(root, opts), {
    expires: Date.now() + (offline ? OFFLINE_TTL_MS : TTL_MS),
    payload,
  });
}

// ---------------------------------------------------------------------------
// Internal helpers (pure)
// ---------------------------------------------------------------------------

interface TopoNode {
  path: string;
  type: string;
  name?: string;
}
interface TopoConn {
  source_path: string;
  source_output: number;
  target_path: string;
  target_input: number;
}

function detectPrimaryOutput(
  nodes: TopoNode[],
  connections: TopoConn[],
  root: string,
): TopoNode | null {
  // 1. exact "out1" child whose type ends in TOP
  const out1Path = `${root.replace(/\/$/, "")}/out1`;
  const out1 = nodes.find((n) => n.path === out1Path && /TOP$/i.test(n.type));
  if (out1) return out1;

  // 2. any node with flags.viewer === true (UNVERIFIED, falls through if absent)
  for (const n of nodes) {
    const flags = (n as { flags?: { viewer?: boolean } }).flags;
    if (flags?.viewer === true && /TOP$/i.test(n.type)) return n;
  }

  // 3. TOP with no outbound + highest fan-in
  const outboundFrom = new Set<string>();
  for (const c of connections) outboundFrom.add(c.source_path);
  const fanIn = new Map<string, number>();
  for (const c of connections) fanIn.set(c.target_path, (fanIn.get(c.target_path) ?? 0) + 1);
  const tops = nodes.filter((n) => /TOP$/i.test(n.type) && !outboundFrom.has(n.path));
  tops.sort((a, b) => (fanIn.get(b.path) ?? 0) - (fanIn.get(a.path) ?? 0));
  return tops[0] ?? null;
}

function walkOutputChain(
  primary: TopoNode,
  nodes: TopoNode[],
  connections: TopoConn[],
  depth: number,
): Array<{ path: string; type: string }> {
  if (depth <= 0) return [{ path: primary.path, type: primary.type }];
  const nodeByPath = new Map<string, TopoNode>();
  for (const n of nodes) nodeByPath.set(n.path, n);
  // adjacency: target -> source (upstream walk)
  const upstream = new Map<string, string[]>();
  for (const c of connections) {
    if (!upstream.has(c.target_path)) upstream.set(c.target_path, []);
    upstream.get(c.target_path)?.push(c.source_path);
  }
  const chain: Array<{ path: string; type: string }> = [];
  const seen = new Set<string>();
  let current: TopoNode | undefined = primary;
  while (current && chain.length < depth) {
    if (seen.has(current.path)) break;
    seen.add(current.path);
    chain.push({ path: current.path, type: current.type });
    const sources = upstream.get(current.path) ?? [];
    let next: TopoNode | undefined;
    for (const src of sources) {
      const node = nodeByPath.get(src);
      if (node && /TOP$/i.test(node.type) && !seen.has(node.path)) {
        next = node;
        break;
      }
    }
    current = next;
  }
  // order source -> primary
  return chain.reverse();
}

function buildFamilies(
  nodes: TopoNode[],
  familyTopTypes: number,
): Record<string, { count: number; topTypes: Array<{ type: string; count: number }> }> {
  const buckets = new Map<string, Map<string, number>>();
  for (const n of nodes) {
    const fam = familyOf(n.type);
    let typeMap = buckets.get(fam);
    if (!typeMap) {
      typeMap = new Map<string, number>();
      buckets.set(fam, typeMap);
    }
    typeMap.set(n.type, (typeMap.get(n.type) ?? 0) + 1);
  }
  const result: Record<
    string,
    { count: number; topTypes: Array<{ type: string; count: number }> }
  > = {};
  for (const fam of [...buckets.keys()].sort()) {
    const typeMap = buckets.get(fam);
    if (!typeMap) continue;
    let count = 0;
    for (const c of typeMap.values()) count += c;
    const topTypes = [...typeMap.entries()]
      .map(([type, c]) => ({ type, count: c }))
      .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type))
      .slice(0, Math.max(0, familyTopTypes));
    result[fam] = { count, topTypes };
  }
  return result;
}

function approxTokens(payload: unknown): number {
  return Math.ceil(JSON.stringify(payload).length / 4);
}

function applyBudget(payload: GraphDigest, maxTokens: number): GraphDigest {
  let current = approxTokens(payload);
  if (current <= maxTokens) {
    payload.approxTokens = current;
    return payload;
  }

  // (a) shrink family_top_types toward 1
  for (let limit = 2; limit >= 1; limit--) {
    for (const fam of Object.keys(payload.families)) {
      const entry = payload.families[fam];
      if (entry && entry.topTypes.length > limit) entry.topTypes = entry.topTypes.slice(0, limit);
    }
    current = approxTokens(payload);
    if (current <= maxTokens) {
      payload.warnings.push(`truncated: family_top_types reduced to ${limit} to fit max_tokens`);
      payload.approxTokens = current;
      return payload;
    }
  }
  payload.warnings.push("truncated: family_top_types reduced to 1 to fit max_tokens");

  // (b) shrink outputChain from the head
  while (payload.outputChain.length > 1) {
    payload.outputChain.shift();
    current = approxTokens(payload);
    if (current <= maxTokens) {
      payload.warnings.push("truncated: outputChain shortened to fit max_tokens");
      payload.approxTokens = current;
      return payload;
    }
  }
  if (payload.outputChain.length > 0) {
    payload.warnings.push("truncated: outputChain shortened to fit max_tokens");
  }

  // (c) drop errors.topGroups past 1
  if (payload.errors.topGroups.length > 1) {
    payload.errors.topGroups = payload.errors.topGroups.slice(0, 1);
    payload.warnings.push("truncated: errors.topGroups capped at 1 to fit max_tokens");
    current = approxTokens(payload);
    if (current <= maxTokens) {
      payload.approxTokens = current;
      return payload;
    }
  }

  // (d) collapse families with count<2 into OTHER
  let otherCount = payload.families.OTHER?.count ?? 0;
  const otherTypes = new Map<string, number>(
    (payload.families.OTHER?.topTypes ?? []).map((t) => [t.type, t.count]),
  );
  let collapsed = false;
  for (const fam of Object.keys(payload.families)) {
    if (fam === "OTHER") continue;
    const entry = payload.families[fam];
    if (entry && entry.count < 2) {
      otherCount += entry.count;
      for (const t of entry.topTypes) {
        otherTypes.set(t.type, (otherTypes.get(t.type) ?? 0) + t.count);
      }
      delete payload.families[fam];
      collapsed = true;
    }
  }
  if (collapsed) {
    payload.families.OTHER = {
      count: otherCount,
      topTypes: [...otherTypes.entries()]
        .map(([type, c]) => ({ type, count: c }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 1),
    };
    payload.warnings.push("truncated: collapsed small families into OTHER to fit max_tokens");
  }

  payload.approxTokens = approxTokens(payload);
  if (payload.approxTokens > maxTokens) {
    payload.overBudget = true;
    payload.warnings.push(
      "Could not fit within maxTokens budget; returned best-effort digest (overBudget=true).",
    );
  }
  return payload;
}

// ---------------------------------------------------------------------------
// buildDigest — pure single source of truth for tool + resource
// ---------------------------------------------------------------------------

export async function buildDigest(
  client: TouchDesignerClient,
  root: string,
  opts: BuildDigestOptions = DEFAULT_DIGEST_OPTIONS,
): Promise<GraphDigest> {
  const hit = getCached(client, root, opts);
  if (hit) return hit;

  const cachedAt = new Date().toISOString();
  const warnings: string[] = [];

  // Fetch topology
  let nodes: TopoNode[] = [];
  let connections: TopoConn[] = [];
  let offline = false;
  try {
    const topo = await client.getNetworkTopology(root, true);
    nodes = topo.nodes as TopoNode[];
    connections = topo.connections as TopoConn[];
  } catch (err) {
    if (err instanceof TdConnectionError) {
      offline = true;
      warnings.push("TouchDesigner bridge not reachable at 127.0.0.1:9980 — digest is empty.");
    } else {
      warnings.push(`Topology fetch failed: ${String(err)}`);
    }
  }

  // Fetch errors
  let errorTotal = 0;
  let topGroups: Array<{ key: string; count: number }> = [];
  if (opts.includeErrors && !offline) {
    try {
      const errs = await client.getNetworkErrors(root);
      errorTotal = errs.errors.length;
      const grouped = groupErrors(errs.errors);
      topGroups = grouped.slice(0, 3).map((g) => ({ key: g.key, count: g.count }));
    } catch (err) {
      warnings.push(`Errors fetch failed: ${String(err)}`);
    }
  }

  const primary = nodes.length > 0 ? detectPrimaryOutput(nodes, connections, root) : null;
  const outputChain =
    opts.includeOutputChain && primary
      ? walkOutputChain(primary, nodes, connections, opts.outputChainDepth)
      : [];

  const families = buildFamilies(nodes, opts.familyTopTypes);

  const header = `${root} · ${nodes.length} nodes · ${connections.length} wires · out: ${primary?.path ?? "?"}`;

  const payload: GraphDigest = {
    path: root,
    header,
    nodeCount: nodes.length,
    connectionCount: connections.length,
    primaryOutput: primary ? { path: primary.path, type: primary.type } : null,
    families,
    outputChain,
    errors: { total: errorTotal, topGroups },
    warnings,
    approxTokens: 0,
    cachedAt,
  };

  payload.approxTokens = approxTokens(payload);
  const fitted = applyBudget(payload, opts.maxTokens);

  setCached(client, root, opts, fitted, offline);
  return fitted;
}

// ---------------------------------------------------------------------------
// Resource registrar — tdmcp://digest/{path}
// ---------------------------------------------------------------------------

export const registerGraphDigestResource: ResourceRegistrar = (server, ctx) => {
  const client = ctx.client;

  const template = new ResourceTemplate("tdmcp://digest/{path}", {
    list: async () => ({
      resources: [
        {
          uri: "tdmcp://digest/%2Fproject1",
          name: "Graph digest: /project1",
          description: "Token-cheap (<500 tok) structured digest of a TD subtree.",
          mimeType: "application/json",
        },
      ],
    }),
  });

  server.registerResource(
    "td-graph-digest",
    template,
    {
      title: "Compact TD graph digest",
      description:
        "Token-cheap (<500 tok) structured digest of a TD subtree: one-line header, " +
        "family counts with top operator types, primary output TOP's upstream chain, " +
        "and top-3 grouped errors. approxTokens is a chars/4 heuristic (±20%). " +
        "If the digest cannot fit within maxTokens after all reductions, overBudget=true " +
        "is set and a warning is appended (best-effort, never throws). Cached 5 s (1 s offline).",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const raw = firstVar(variables.path);
      const path = raw ? decodeURIComponent(raw) : "/project1";

      if (!client) {
        return jsonContents(uri, {
          error: "No TD client available — resource context missing client.",
        });
      }

      const data = await buildDigest(client, path, DEFAULT_DIGEST_OPTIONS);
      return jsonContents(uri, data);
    },
  );
};

// Test-only: reset the in-memory cache.
export function _resetDigestCache(client?: TouchDesignerClient): void {
  if (client) {
    cache.delete(client);
    return;
  }
  cache = new WeakMap<TouchDesignerClient, Map<string, DigestCacheEntry>>();
}
