import { describe, expect, it } from "vitest";
import {
  buildRepositionRequest,
  canonicalizeExplicitPlacement,
  explicitPlacementOptionsSchema,
  explicitPositionsSchema,
  repositionFailureReceiptSchema,
  repositionReceiptSchema,
} from "../../src/tools/explicitPlacement.js";

const fingerprint = "a".repeat(64);

function context(requestedPaths = ["/project1/show/a", "/project1/show/z"]) {
  return {
    root_path: "/project1/show",
    target_source: "provided_paths" as const,
    include_docked: true,
    requested_paths: requestedPaths,
    nodes: requestedPaths.map((path) => ({
      path,
      position: [0, 0] as [number, number],
      source: "explicit" as const,
    })),
    editor_context: null,
    fingerprint,
  };
}

describe("explicit placement helper", () => {
  it("canonicalizes insertion-independent positions and preserves the opaque key", () => {
    const canonical = canonicalizeExplicitPlacement({
      root_path: "/project1/show",
      positions: {
        "/project1/show/z": [1_000_000, -1_000_000],
        "/project1/show/a": [-20, 40],
      },
      target_source: "provided_paths",
      include_docked: true,
      idempotency_key: "wave10-explicit-key-0001",
    });

    expect(canonical.positions).toEqual([
      { path: "/project1/show/a", x: -20, y: 40 },
      { path: "/project1/show/z", x: 1_000_000, y: -1_000_000 },
    ]);
    expect(canonical.idempotency_key).toBe("wave10-explicit-key-0001");
  });

  it("accepts the exact placement capacity and rejects every unsafe bound", () => {
    const maximum = Object.fromEntries(
      Array.from({ length: 256 }, (_, index) => [
        `/project1/show/node_${String(index).padStart(3, "0")}`,
        [index, -index],
      ]),
    );
    expect(explicitPositionsSchema.safeParse(maximum).success).toBe(true);
    expect(explicitPositionsSchema.safeParse({}).success).toBe(false);
    expect(
      explicitPositionsSchema.safeParse({
        ...maximum,
        "/project1/show/overflow": [0, 0],
      }).success,
    ).toBe(false);
    for (const position of [
      [1.5, 0],
      [Number.NaN, 0],
      [Number.POSITIVE_INFINITY, 0],
      [1_000_001, 0],
      [-1_000_001, 0],
    ]) {
      expect(explicitPositionsSchema.safeParse({ "/project1/show/node": position }).success).toBe(
        false,
      );
    }
  });

  it("rejects non-normalized paths, root replacement and unsafe idempotency keys", () => {
    const base = {
      root_path: "/project1/show",
      positions: { "/project1/show/node": [0, 0] as [number, number] },
      target_source: "provided_paths" as const,
      include_docked: false,
      idempotency_key: "wave10-explicit-key-0001",
    };
    expect(explicitPlacementOptionsSchema.safeParse(base).success).toBe(true);
    expect(
      explicitPlacementOptionsSchema.safeParse({ ...base, positions: { relative: [0, 0] } })
        .success,
    ).toBe(false);
    expect(
      explicitPlacementOptionsSchema.safeParse({
        ...base,
        positions: { "/project1/show/../node": [0, 0] },
      }).success,
    ).toBe(false);
    expect(
      explicitPlacementOptionsSchema.safeParse({ ...base, positions: { "/": [0, 0] } }).success,
    ).toBe(false);
    expect(
      explicitPlacementOptionsSchema.safeParse({ ...base, idempotency_key: "too-short" }).success,
    ).toBe(false);
  });

  it("caps active-selection placement at the compact editor-context bound", () => {
    const positions = Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [`/project1/show/n${index}`, [index, 0]]),
    );
    expect(
      explicitPlacementOptionsSchema.safeParse({
        root_path: "/project1/show",
        positions,
        target_source: "active_selection",
        include_docked: true,
        idempotency_key: "wave10-explicit-key-0001",
      }).success,
    ).toBe(false);
  });

  it("builds an apply request only from the matching strict context", () => {
    const canonical = canonicalizeExplicitPlacement({
      root_path: "/project1/show",
      positions: {
        "/project1/show/z": [50, -20],
        "/project1/show/a": [10, 20],
      },
      target_source: "provided_paths",
      include_docked: true,
      idempotency_key: "wave10-explicit-key-0001",
    });

    expect(buildRepositionRequest(canonical, context())).toEqual({
      root_path: "/project1/show",
      target_source: "provided_paths",
      include_docked: true,
      positions: [
        { path: "/project1/show/a", x: 10, y: 20 },
        { path: "/project1/show/z", x: 50, y: -20 },
      ],
      fingerprint,
      editor_context: null,
      idempotency_key: "wave10-explicit-key-0001",
    });
    expect(() =>
      buildRepositionRequest(canonical, { ...context(), root_path: "/project1/other" }),
    ).toThrow("does not match");
    expect(() => buildRepositionRequest(canonical, context(["/project1/show/a"]))).toThrow(
      "path set",
    );
  });

  it("validates success, unchanged and replay receipts without accepting malformed readback", () => {
    const receipt = {
      mode: "explicit" as const,
      status: "applied" as const,
      idempotency_key: "wave10-explicit-key-0001",
      root_path: "/project1/show",
      target_source: "provided_paths" as const,
      fingerprint_before: fingerprint,
      fingerprint_after: "b".repeat(64),
      paths: [
        {
          path: "/project1/show/a",
          source: "explicit" as const,
          requested: [10, 20] as [number, number],
          previous: [0, 0] as [number, number],
          final: [10, 20] as [number, number],
          status: "applied" as const,
        },
      ],
      counts: { explicit: 1, docked_carried: 0, applied: 1, unchanged: 0, failed: 0 },
      rollback: { attempted: false as const, succeeded: true as const, errors: [] },
      warnings: [],
    };
    expect(repositionReceiptSchema.safeParse(receipt).success).toBe(true);
    expect(
      repositionReceiptSchema.safeParse({
        ...receipt,
        status: "unchanged",
        paths: [{ ...receipt.paths[0], status: "unchanged" }],
        counts: { ...receipt.counts, applied: 0, unchanged: 1 },
      }).success,
    ).toBe(true);
    expect(repositionReceiptSchema.safeParse({ ...receipt, status: "replayed" }).success).toBe(
      true,
    );
    expect(
      repositionReceiptSchema.safeParse({
        ...receipt,
        paths: [{ ...receipt.paths[0], final: [10.5, 20] }],
      }).success,
    ).toBe(false);
  });

  it("validates bounded transactional failure details", () => {
    const failure = {
      mode: "explicit" as const,
      status: "failed" as const,
      idempotency_key: "wave10-explicit-key-0001",
      root_path: "/project1/show",
      target_source: "provided_paths" as const,
      paths: [
        {
          path: "/project1/show/a",
          source: "explicit" as const,
          requested: [10, 20] as [number, number],
          previous: [0, 0] as [number, number],
          final: [10, 20] as [number, number],
          status: "failed" as const,
          rollback: "restored" as const,
        },
      ],
      counts: { explicit: 1, docked_carried: 0, applied: 0, unchanged: 0, failed: 1 },
      rollback: { attempted: true as const, succeeded: true, errors: [] },
      error: {
        code: "reposition_apply_failed",
        message: "Explicit placement failed and every affected position was restored.",
      },
      warnings: [],
    };
    expect(repositionFailureReceiptSchema.safeParse(failure).success).toBe(true);
    expect(
      repositionFailureReceiptSchema.safeParse({
        ...failure,
        error: { ...failure.error, message: "x".repeat(161) },
      }).success,
    ).toBe(false);
  });
});
