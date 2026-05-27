import { describe, expect, it } from "vitest";
import { diffSnapshots, diffSnapshotsImpl } from "../../src/tools/layer3/diffSnapshots.js";
import type { ToolContext } from "../../src/tools/types.js";

describe("diffSnapshots (pure)", () => {
  it("reports added and removed nodes", () => {
    const diff = diffSnapshots(
      { nodes: [{ path: "/a" }, { path: "/b" }], connections: [] },
      { nodes: [{ path: "/b" }, { path: "/c" }], connections: [] },
    );
    expect(diff.nodes_added).toEqual(["/c"]);
    expect(diff.nodes_removed).toEqual(["/a"]);
    expect(diff.unchanged).toBe(false);
  });

  it("detects parameter changes with before/after values", () => {
    const diff = diffSnapshots(
      { nodes: [{ path: "/a", parameters: { period: 4, gain: 1 } }], connections: [] },
      { nodes: [{ path: "/a", parameters: { period: 8, gain: 1 } }], connections: [] },
    );
    expect(diff.parameter_changes).toHaveLength(1);
    expect(diff.parameter_changes[0]?.path).toBe("/a");
    expect(diff.parameter_changes[0]?.changes.period).toEqual({ from: 4, to: 8 });
    // gain is unchanged, so it should not appear.
    expect(diff.parameter_changes[0]?.changes.gain).toBeUndefined();
  });

  it("reports added and removed connections", () => {
    const diff = diffSnapshots(
      {
        nodes: [],
        connections: [{ source_path: "/a", target_path: "/b" }],
      },
      {
        nodes: [],
        connections: [{ source_path: "/b", target_path: "/c" }],
      },
    );
    expect(diff.connections_added).toEqual(["/b:0 -> /c:0"]);
    expect(diff.connections_removed).toEqual(["/a:0 -> /b:0"]);
  });

  it("flags two identical snapshots as unchanged", () => {
    const snap = {
      nodes: [{ path: "/a", parameters: { x: 1 } }],
      connections: [{ source_path: "/a", target_path: "/b" }],
    };
    const diff = diffSnapshots(snap, snap);
    expect(diff.unchanged).toBe(true);
    expect(diff.nodes_added).toEqual([]);
    expect(diff.nodes_removed).toEqual([]);
    expect(diff.parameter_changes).toEqual([]);
  });
});

describe("diffSnapshotsImpl", () => {
  it("summarises 'no differences' for identical snapshots", () => {
    const snap = { nodes: [{ path: "/a" }], connections: [] };
    const result = diffSnapshotsImpl({} as ToolContext, { before: snap, after: snap });
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("No differences"),
    });
  });

  it("summarises the counts of changes for differing snapshots", () => {
    const result = diffSnapshotsImpl({} as ToolContext, {
      before: { nodes: [{ path: "/a" }], connections: [] },
      after: { nodes: [{ path: "/a" }, { path: "/b" }], connections: [] },
    });
    const data = (result as { structuredContent?: { nodes_added: string[] } }).structuredContent;
    expect(data?.nodes_added).toEqual(["/b"]);
    const text = (result.content[0] as { text?: string }).text ?? "";
    expect(text).toContain("+1");
  });
});
