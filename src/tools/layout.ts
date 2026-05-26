/**
 * Network-editor auto-layout. Arranges nodes left→right along their data flow so
 * a generated (or existing) network reads as sources-on-the-left, output-on-the-right
 * instead of every node piling up at the same coordinate.
 *
 * Positions are written through TouchDesigner's `nodeX`/`nodeY` *attributes* (not
 * parameters), so they have no structured setter and are applied via a small Python
 * snippet — the same exec-for-attributes pattern used elsewhere for `numBlocks`.
 */

/** Horizontal gap between successive data-flow layers, in TD network units. */
const X_STEP = 200;
/** Vertical gap between sibling nodes within a layer, in TD network units. */
const Y_STEP = 140;
/** Breathing room left between an existing cluster and a newly placed node. */
const SIBLING_GAP = 80;

export interface LayoutEdge {
  from: string;
  to: string;
}

/** Map of node path → `[nodeX, nodeY]`. */
export type Positions = Record<string, [number, number]>;

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}

/** Parent network path of a node path (everything before the last "/"). */
export function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}

/**
 * Assigns each node a layer = the longest data-flow path leading into it, so
 * sources land at layer 0 and each node sits one column right of its deepest input.
 * Back-edges (feedback loops) contribute nothing, which keeps cyclic networks
 * finite and readable.
 */
function layerByLongestPath(
  nodes: readonly string[],
  preds: Map<string, string[]>,
): Map<string, number> {
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (node: string): number => {
    const cached = memo.get(node);
    if (cached !== undefined) return cached;
    if (visiting.has(node)) return 0; // back-edge inside a cycle
    visiting.add(node);
    let best = 0;
    for (const pred of preds.get(node) ?? []) best = Math.max(best, depth(pred) + 1);
    visiting.delete(node);
    memo.set(node, best);
    return best;
  };
  const layers = new Map<string, number>();
  for (const node of nodes) layers.set(node, depth(node));
  return layers;
}

/**
 * Computes left→right data-flow coordinates for one set of sibling nodes. Edges
 * touching a node outside the set are ignored, so callers spanning nested COMPs
 * must group by parent first (see {@link computeLayoutByParent}). Within a layer,
 * nodes are stacked vertically and centered, preserving their input order.
 */
export function computeDataflowLayout(
  nodes: readonly string[],
  edges: readonly LayoutEdge[],
): Positions {
  const set = new Set(nodes);
  const preds = new Map<string, string[]>();
  for (const { from, to } of edges) {
    if (from === to || !set.has(from) || !set.has(to)) continue;
    pushTo(preds, to, from);
  }

  const layerOf = layerByLongestPath(nodes, preds);
  const byLayer = new Map<number, string[]>();
  for (const node of nodes) pushTo(byLayer, layerOf.get(node) ?? 0, node);

  const positions: Positions = {};
  for (const [layer, members] of byLayer) {
    const center = (members.length - 1) / 2;
    members.forEach((node, i) => {
      positions[node] = [layer * X_STEP, (center - i) * Y_STEP];
    });
  }
  return positions;
}

/**
 * Groups node paths by parent network and lays out each group independently,
 * merging the results. Use when a node set may span nested COMPs (e.g. a system
 * container holding child COMPs that have their own internal networks).
 */
export function computeLayoutByParent(
  nodes: readonly string[],
  edges: readonly LayoutEdge[],
): Positions {
  const groups = new Map<string, string[]>();
  for (const node of nodes) pushTo(groups, parentOf(node), node);

  const merged: Positions = {};
  for (const members of groups.values()) {
    Object.assign(merged, computeDataflowLayout(members, edges));
  }
  return merged;
}

/**
 * Builds a Python snippet that writes `nodeX`/`nodeY` for each path. The position
 * map is JSON-encoded (a valid Python literal for this string/number subset) and
 * applied defensively, so a stale path can't abort the rest of the batch.
 */
export function layoutScript(positions: Positions): string {
  return [
    `_pos = ${JSON.stringify(positions)}`,
    "for _p, _xy in _pos.items():",
    "    _n = op(_p)",
    "    if _n is not None:",
    "        _n.nodeX = _xy[0]",
    "        _n.nodeY = _xy[1]",
  ].join("\n");
}

/**
 * Builds a Python snippet that drops a just-created node clear of its existing
 * siblings — left-aligned with the current cluster and one gap below its lowest
 * node — so repeated top-level creations stack into a tidy column instead of
 * piling up at the origin. The first node in an empty network lands at (0, 0).
 */
export function placeBelowSiblingsScript(parentPath: string, nodePath: string): string {
  const q = JSON.stringify;
  return [
    `_parent = op(${q(parentPath)})`,
    `_new = op(${q(nodePath)})`,
    "if _parent is not None and _new is not None:",
    "    _sibs = [c for c in _parent.children if c is not _new]",
    "    if _sibs:",
    "        _new.nodeX = min(c.nodeX for c in _sibs)",
    `        _new.nodeY = min(c.nodeY for c in _sibs) - _new.nodeHeight - ${SIBLING_GAP}`,
    "    else:",
    "        _new.nodeX = 0",
    "        _new.nodeY = 0",
  ].join("\n");
}
