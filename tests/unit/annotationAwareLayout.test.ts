import { describe, expect, it } from "vitest";
import {
  AnnotationAwareLayoutError,
  type AnnotationAwareLayoutErrorCode,
  type AnnotationAwareLayoutInput,
  type AnnotationLayoutInput,
  type AnnotationLayoutRect,
  type PlannedBounds,
  planAnnotationAwareLayout,
} from "../../src/tools/annotationAwareLayout.js";

function node(path: string, x: number, y: number, w = 100, h = 60): AnnotationLayoutRect {
  return { path, x, y, w, h };
}

function annotation(
  path: string,
  x: number,
  y: number,
  w: number,
  h: number,
  enclosed_paths: string[] = [],
): AnnotationLayoutInput {
  return { path, x, y, w, h, enclosed_paths };
}

function expectCode(run: () => unknown, code: AnnotationAwareLayoutErrorCode): void {
  try {
    run();
    throw new Error("expected annotation-aware layout to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(AnnotationAwareLayoutError);
    expect((error as AnnotationAwareLayoutError).code).toBe(code);
  }
}

function overlaps(left: PlannedBounds, right: PlannedBounds): boolean {
  const horizontal = Math.min(left.x + left.w, right.x + right.w) > Math.max(left.x, right.x);
  const vertical = Math.min(left.y, right.y) > Math.max(left.y - left.h, right.y - right.h);
  return horizontal && vertical;
}

function expectNoUnitOverlap(input: AnnotationAwareLayoutInput): void {
  const plan = planAnnotationAwareLayout(input);
  plan.units.forEach((unit, index) => {
    for (const other of plan.units.slice(index + 1)) {
      expect(overlaps(unit.target_bounds, other.target_bounds)).toBe(false);
    }
  });
}

function position(
  plan: ReturnType<typeof planAnnotationAwareLayout>,
  path: string,
): [number, number] {
  const value = plan.positions[path];
  if (!value) throw new Error(`missing planned position for ${path}`);
  return value;
}

describe("planAnnotationAwareLayout", () => {
  it("treats an annotation group as one unit and carries docked children once", () => {
    const input: AnnotationAwareLayoutInput = {
      nodes: [
        node("/project1/a", -20, 50),
        node("/project1/b", 120, -20),
        node("/project1/out", 700, 40),
      ],
      annotations: [
        annotation("/project1/box", -100, 100, 400, 300, ["/project1/a", "/project1/b"]),
      ],
      docked: [
        {
          ...node("/project1/a_callbacks", -10, 0, 50, 40),
          host_path: "/project1/a",
        },
      ],
      edges: [{ from: "/project1/b", to: "/project1/out" }],
    };
    const plan = planAnnotationAwareLayout(input);

    expect(position(plan, "/project1/box")).toEqual([0, 0]);
    expect(position(plan, "/project1/a")).toEqual([80, -50]);
    expect(position(plan, "/project1/b")).toEqual([220, -120]);
    expect(position(plan, "/project1/a_callbacks")).toEqual([90, -100]);
    expect(position(plan, "/project1/out")).toEqual([600, 0]);
    expect(position(plan, "/project1/b")[0] - position(plan, "/project1/a")[0]).toBe(140);
    expect(position(plan, "/project1/b")[1] - position(plan, "/project1/a")[1]).toBe(-70);
    expect(position(plan, "/project1/a_callbacks")[0] - position(plan, "/project1/a")[0]).toBe(10);
    expect(position(plan, "/project1/a_callbacks")[1] - position(plan, "/project1/a")[1]).toBe(-50);
    expect(plan.collapsed_edges).toEqual([
      { from: "annotation:/project1/box", to: "node:/project1/out" },
    ]);
    expect(plan.counts).toEqual({
      units: 2,
      hosts: 3,
      docked: 1,
      annotations: 1,
      resized_annotations: 0,
    });
    expectNoUnitOverlap(input);
  });

  it("rejects positive-area overlap and nesting but permits edge touch", () => {
    const base = annotation("/project1/a", 0, 100, 100, 100);
    expect(() =>
      planAnnotationAwareLayout({
        nodes: [],
        annotations: [base, annotation("/project1/b", 100, 100, 100, 100)],
      }),
    ).not.toThrow();

    expectCode(
      () =>
        planAnnotationAwareLayout({
          nodes: [],
          annotations: [base, annotation("/project1/b", 99, 100, 100, 100)],
        }),
      "ambiguous_annotation_geometry",
    );
    expectCode(
      () =>
        planAnnotationAwareLayout({
          nodes: [],
          annotations: [base, annotation("/project1/b", 10, 90, 20, 20)],
        }),
      "ambiguous_annotation_geometry",
    );
  });

  it("rejects duplicate membership before planning any positions", () => {
    expectCode(
      () =>
        planAnnotationAwareLayout({
          nodes: [node("/project1/n", 0, 0)],
          annotations: [
            annotation("/project1/a", -200, 100, 100, 100, ["/project1/n"]),
            annotation("/project1/b", 200, 100, 100, 100, ["/project1/n"]),
          ],
        }),
      "ambiguous_annotation_membership",
    );
  });

  it("resizes an annotation to exact negative-coordinate content bounds plus padding", () => {
    const input: AnnotationAwareLayoutInput = {
      nodes: [node("/project1/a", -300, -50, 100, 60), node("/project1/b", -120, -200, 80, 50)],
      annotations: [
        annotation("/project1/box", -500, 200, 700, 600, ["/project1/a", "/project1/b"]),
      ],
      resize_annotations: true,
      annotation_padding: 20,
    };
    const plan = planAnnotationAwareLayout(input);

    expect(plan.annotation_bounds["/project1/box"]).toEqual({
      x: 0,
      y: 0,
      w: 300,
      h: 240,
      resized: true,
    });
    expect(plan.positions["/project1/box"]).toEqual([0, 0]);
    expect(plan.positions["/project1/a"]).toEqual([20, -20]);
    expect(plan.positions["/project1/b"]).toEqual([200, -170]);
    expect(plan.counts.resized_annotations).toBe(1);
  });

  it("keeps empty annotations at their original size even when resize is enabled", () => {
    const plan = planAnnotationAwareLayout({
      nodes: [],
      annotations: [annotation("/project1/empty", -500, -100, 250, 120)],
      resize_annotations: true,
      annotation_padding: 30,
    });
    expect(plan.annotation_bounds["/project1/empty"]).toEqual({
      x: 0,
      y: 0,
      w: 250,
      h: 120,
      resized: false,
    });
    expect(plan.counts.resized_annotations).toBe(0);
  });

  it("is stable for disconnected variable-size units and produces no overlap", () => {
    const input: AnnotationAwareLayoutInput = {
      nodes: [node("/project1/z", -1000, -800, 500, 400), node("/project1/a", 900, 700, 100, 60)],
      annotations: [annotation("/project1/empty", -300, 300, 800, 500)],
      edges: [],
    };
    const first = planAnnotationAwareLayout(input);
    const second = planAnnotationAwareLayout(input);
    expect(first).toEqual(second);
    expectNoUnitOverlap(input);
    expect(first.units.map((unit) => unit.id)).toEqual([
      "annotation:/project1/empty",
      "node:/project1/a",
      "node:/project1/z",
    ]);
  });

  it("collapses cyclic host edges deterministically and remains finite", () => {
    const input: AnnotationAwareLayoutInput = {
      nodes: [node("/project1/a", 0, 0), node("/project1/b", 0, 0), node("/project1/c", 0, 0)],
      annotations: [],
      edges: [
        { from: "/project1/a", to: "/project1/b" },
        { from: "/project1/b", to: "/project1/a" },
        { from: "/project1/b", to: "/project1/c" },
      ],
    };
    const first = planAnnotationAwareLayout(input);
    const second = planAnnotationAwareLayout(input);
    expect(first).toEqual(second);
    expect(first.collapsed_edges).toHaveLength(3);
    expect(first.units.every((unit) => Number.isSafeInteger(unit.layer))).toBe(true);
    expectNoUnitOverlap(input);
  });

  it("omits docked children entirely when include_docked is false", () => {
    const plan = planAnnotationAwareLayout({
      nodes: [node("/project1/a", 50, 50)],
      annotations: [],
      docked: [{ ...node("/project1/a_callbacks", 70, 20), host_path: "/ignored" }],
      include_docked: false,
    });
    expect(plan.positions["/project1/a"]).toEqual([0, 0]);
    expect(plan.positions["/project1/a_callbacks"]).toBeUndefined();
    expect(plan.units[0]?.docked_paths).toEqual([]);
    expect(plan.counts.docked).toBe(0);
  });

  it("rejects unknown annotation members and docked hosts", () => {
    expectCode(
      () =>
        planAnnotationAwareLayout({
          nodes: [],
          annotations: [annotation("/project1/a", 0, 0, 100, 100, ["/project1/missing"])],
        }),
      "unknown_annotation_member",
    );
    expectCode(
      () =>
        planAnnotationAwareLayout({
          nodes: [],
          annotations: [],
          docked: [{ ...node("/project1/callbacks", 0, 0), host_path: "/project1/missing" }],
        }),
      "unknown_docked_host",
    );
  });

  it("enforces bounded padding, geometry, paths and capacity", () => {
    expectCode(
      () =>
        planAnnotationAwareLayout({
          nodes: [node("/project1/a", 0, 0)],
          annotations: [],
          annotation_padding: 1001,
        }),
      "invalid_layout_input",
    );
    expectCode(
      () => planAnnotationAwareLayout({ nodes: [node("relative", 0, 0)], annotations: [] }),
      "invalid_layout_input",
    );
    expectCode(
      () => planAnnotationAwareLayout({ nodes: [node("/project1/a", 0, 0, 0)], annotations: [] }),
      "invalid_layout_input",
    );
    expectCode(
      () =>
        planAnnotationAwareLayout({
          nodes: [node("/project1/a", 1_000_001, 0)],
          annotations: [],
        }),
      "invalid_layout_input",
    );
    expectCode(
      () =>
        planAnnotationAwareLayout({
          nodes: [
            node("/project1/a", 0, 0, 1_000_000, 60),
            node("/project1/b", 0, 0, 1_000_000, 60),
          ],
          annotations: [],
          edges: [{ from: "/project1/a", to: "/project1/b" }],
        }),
      "capacity_exceeded",
    );
    const tooMany = Array.from({ length: 513 }, (_, index) =>
      node(`/project1/n${index}`, index * 10, 0),
    );
    expectCode(
      () => planAnnotationAwareLayout({ nodes: tooMany, annotations: [] }),
      "capacity_exceeded",
    );
  });

  it("does not mutate caller-owned arrays or records", () => {
    const input: AnnotationAwareLayoutInput = {
      nodes: [node("/project1/b", 30, -20), node("/project1/a", -10, 40)],
      annotations: [],
      edges: [{ from: "/project1/a", to: "/project1/b" }],
    };
    const before = structuredClone(input);
    planAnnotationAwareLayout(input);
    expect(input).toEqual(before);
  });
});
