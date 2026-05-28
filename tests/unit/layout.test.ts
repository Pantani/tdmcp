import { describe, expect, it } from "vitest";
import {
  computeDataflowLayout,
  computeLayoutByParent,
  type LayoutEdge,
  layoutScript,
  type Positions,
  parentOf,
  placeInGridScript,
} from "../../src/tools/layout.js";

/** Reads a node's coordinate, failing loudly if the layout omitted it. */
function xy(pos: Positions, key: string): [number, number] {
  const value = pos[key];
  if (!value) throw new Error(`expected a position for ${key}`);
  return value;
}

describe("parentOf", () => {
  it("returns the network path above a node", () => {
    expect(parentOf("/project1/sys/noise1")).toBe("/project1/sys");
    expect(parentOf("/noise1")).toBe("/");
  });
});

describe("computeDataflowLayout", () => {
  it("places a linear chain left→right at the same height", () => {
    const nodes = ["/p/a", "/p/b", "/p/c"];
    const edges: LayoutEdge[] = [
      { from: "/p/a", to: "/p/b" },
      { from: "/p/b", to: "/p/c" },
    ];
    const pos = computeDataflowLayout(nodes, edges);
    expect(xy(pos, "/p/a")[0]).toBeLessThan(xy(pos, "/p/b")[0]);
    expect(xy(pos, "/p/b")[0]).toBeLessThan(xy(pos, "/p/c")[0]);
    // Each layer has a single node, so all sit centered on the same row.
    expect(xy(pos, "/p/a")[1]).toBe(xy(pos, "/p/b")[1]);
    expect(xy(pos, "/p/b")[1]).toBe(xy(pos, "/p/c")[1]);
  });

  it("puts two sources in the same column and stacks them apart", () => {
    const nodes = ["/p/a", "/p/b", "/p/sink"];
    const edges: LayoutEdge[] = [
      { from: "/p/a", to: "/p/sink" },
      { from: "/p/b", to: "/p/sink" },
    ];
    const pos = computeDataflowLayout(nodes, edges);
    // a and b are both sources → layer 0, same x; sink is downstream → larger x.
    expect(xy(pos, "/p/a")[0]).toBe(xy(pos, "/p/b")[0]);
    expect(xy(pos, "/p/sink")[0]).toBeGreaterThan(xy(pos, "/p/a")[0]);
    // The two siblings do not overlap.
    expect(xy(pos, "/p/a")[1]).not.toBe(xy(pos, "/p/b")[1]);
  });

  it("stays finite on a feedback cycle", () => {
    const nodes = ["/p/a", "/p/b"];
    const edges: LayoutEdge[] = [
      { from: "/p/a", to: "/p/b" },
      { from: "/p/b", to: "/p/a" },
    ];
    const pos = computeDataflowLayout(nodes, edges);
    for (const node of nodes) {
      expect(Number.isFinite(xy(pos, node)[0])).toBe(true);
      expect(Number.isFinite(xy(pos, node)[1])).toBe(true);
    }
  });

  it("ignores edges to nodes outside the set", () => {
    const pos = computeDataflowLayout(["/p/a"], [{ from: "/p/a", to: "/other/x" }]);
    expect(Object.keys(pos)).toEqual(["/p/a"]);
    expect(xy(pos, "/p/a")).toEqual([0, 0]);
  });
});

describe("computeLayoutByParent", () => {
  it("lays out each parent network independently", () => {
    const nodes = ["/p/a", "/p/b", "/p/child/x", "/p/child/y"];
    const edges: LayoutEdge[] = [
      { from: "/p/a", to: "/p/b" },
      { from: "/p/child/x", to: "/p/child/y" },
    ];
    const pos = computeLayoutByParent(nodes, edges);
    // Both networks start their own flow at x = 0.
    expect(xy(pos, "/p/a")[0]).toBe(0);
    expect(xy(pos, "/p/child/x")[0]).toBe(0);
    // Downstream node in each network moves right.
    expect(xy(pos, "/p/b")[0]).toBeGreaterThan(0);
    expect(xy(pos, "/p/child/y")[0]).toBeGreaterThan(0);
  });
});

describe("layoutScript", () => {
  it("emits Python that assigns nodeX/nodeY for each path", () => {
    const script = layoutScript({ "/p/a": [0, 0], "/p/b": [200, -140] });
    expect(script).toContain('"/p/a":[0,0]');
    expect(script).toContain("_n.nodeX = _xy[0]");
    expect(script).toContain("_n.nodeY = _xy[1]");
    expect(script).toContain("if _n is not None:");
  });
});

describe("placeInGridScript", () => {
  it("emits Python that tiles a new node into the first free grid cell", () => {
    const script = placeInGridScript("/project1", "/project1/sys2");
    expect(script).toContain('_parent = op("/project1")');
    expect(script).toContain('_new = op("/project1/sys2")');
    // Occupied cells are derived from every sibling except the new node.
    expect(script).toContain("_occ = {_cell(_c) for _c in _parent.children if _c is not _new}");
    // Scans forward to the first free (col, row), wrapping columns after _rows.
    expect(script).toContain("while (_k // _rows, _k % _rows) in _occ:");
    expect(script).toContain("_new.nodeX = (_k // _rows) * _cw");
    expect(script).toContain("_new.nodeY = -((_k % _rows) * _ch)");
  });
});
