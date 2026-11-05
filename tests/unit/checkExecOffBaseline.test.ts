import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain .mjs script without declarations
import { baselineGrowth } from "../../scripts/check-exec-off-baseline.mjs";

const baseline = (lists: Record<string, string[]> = {}) => ({
  placement_only: [],
  degraded: [],
  blocked: [],
  unverified: [],
  ...lists,
});

describe("exec-off baseline shrink-only guard", () => {
  it("allows removal and improvement", () => {
    const base = baseline({ blocked: ["a", "b"], degraded: ["c"] });
    const head = baseline({ degraded: ["a"], placement_only: ["c"] });
    expect(baselineGrowth(base, head)).toEqual([]);
  });

  it("flags a new entry, which means a tool that used to be clean", () => {
    expect(baselineGrowth(baseline(), baseline({ blocked: ["new_tool"] }))).toEqual([
      "new_tool: clean -> blocked",
    ]);
  });

  it("flags a tool moving to a worse list", () => {
    const base = baseline({ degraded: ["a"], blocked: ["b"] });
    const head = baseline({ blocked: ["a"], unverified: ["b"] });
    expect(baselineGrowth(base, head)).toEqual([
      "a: degraded -> blocked",
      "b: blocked -> unverified",
    ]);
  });

  it("flags a tool leaving the core set, and allows one joining", () => {
    expect(baselineGrowth(baseline({ core: ["a"] }), baseline({ core: ["b"] }))).toEqual([
      "a: removed from core",
    ]);
  });

  it("allows an unverified tool to become measured, even if blocked", () => {
    expect(baselineGrowth(baseline({ unverified: ["a"] }), baseline({ blocked: ["a"] }))).toEqual(
      [],
    );
  });
});
