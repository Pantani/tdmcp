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
/** Horizontal pitch between project columns when tiling the top-level grid. */
const GRID_COL_STEP = 260;
/** Vertical pitch between projects within a grid column. */
const GRID_ROW_STEP = 200;
/** Projects stacked in a column before wrapping to the next column to the right. */
const GRID_ROWS = 6;

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
 *
 * When `includeDocked` (default), each node's docked DATs — e.g. a GLSL TOP's
 * `*_pixel` DAT or a COMP's callbacks DAT — are shifted by the SAME delta the node
 * moved, mimicking an interactive drag (programmatic nodeX/nodeY writes otherwise
 * leave docked DATs stranded at their old spot).
 */
export function layoutScript(positions: Positions, includeDocked = true): string {
  const lines = [
    `_pos = ${JSON.stringify(positions)}`,
    "for _p, _xy in _pos.items():",
    "    _n = op(_p)",
    "    if _n is not None:",
  ];
  if (includeDocked) {
    lines.push("        _dx = _xy[0] - _n.nodeX", "        _dy = _xy[1] - _n.nodeY");
  }
  lines.push("        _n.nodeX = _xy[0]", "        _n.nodeY = _xy[1]");
  if (includeDocked) {
    lines.push(
      "        for _d in getattr(_n, 'docked', []) or []:",
      "            try:",
      "                _d.nodeX += _dx",
      "                _d.nodeY += _dy",
      "            except Exception:",
      "                pass",
    );
  }
  return lines.join("\n");
}

/**
 * Builds a Python snippet that drops a just-created node into the first free cell of a
 * 2D grid among its siblings: it scans a column top→bottom, then wraps to the next
 * column to the right after {@link GRID_ROWS} rows. Cells already covered by a sibling
 * (any family) are skipped, so repeated top-level creations tile into a readable grid
 * instead of piling at the origin or growing one ever-taller column. The first node in
 * an empty network lands at (0, 0). Reads the siblings' live sizes, never the new
 * node's (which may be unreliable right after creation).
 */
export function placeInGridScript(parentPath: string, nodePath: string): string {
  const q = JSON.stringify;
  return [
    `_parent = op(${q(parentPath)})`,
    `_new = op(${q(nodePath)})`,
    "if _parent is not None and _new is not None:",
    `    _cw, _ch, _rows = ${GRID_COL_STEP}, ${GRID_ROW_STEP}, ${GRID_ROWS}`,
    "    def _cell(_c):",
    "        return (round((_c.nodeX + _c.nodeWidth / 2.0) / _cw), round(-(_c.nodeY + _c.nodeHeight / 2.0) / _ch))",
    "    _occ = {_cell(_c) for _c in _parent.children if _c is not _new}",
    "    _k = 0",
    "    while (_k // _rows, _k % _rows) in _occ:",
    "        _k += 1",
    "    _new.nodeX = (_k // _rows) * _cw",
    "    _new.nodeY = -((_k % _rows) * _ch)",
  ].join("\n");
}
