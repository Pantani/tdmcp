import { describe, expect, it } from "vitest";
import { globToRegExp, parentOf } from "../../src/tools/layer3/nodeMatch.js";

describe("globToRegExp", () => {
  it("matches a * wildcard against any suffix, case-insensitively", () => {
    const re = globToRegExp("noise*");
    expect(re.test("noise1")).toBe(true);
    expect(re.test("NOISETOP")).toBe(true);
    expect(re.test("blur1")).toBe(false);
  });

  it("treats * as match-anything in the middle and edges", () => {
    const re = globToRegExp("*blur*");
    expect(re.test("lumablurTOP")).toBe(true);
    expect(re.test("blur")).toBe(true);
    expect(re.test("noise")).toBe(false);
  });

  it("escapes regex metacharacters so they match literally", () => {
    // The '.' must be a literal dot, not the regex 'any character'.
    const re = globToRegExp("a.b");
    expect(re.test("a.b")).toBe(true);
    expect(re.test("axb")).toBe(false);
  });
});

describe("parentOf", () => {
  it("returns the parent path of a nested node", () => {
    expect(parentOf("/project1/moviein1")).toBe("/project1");
  });

  it("returns root for a top-level node", () => {
    expect(parentOf("/project1")).toBe("/");
  });

  it("returns root for the root itself", () => {
    expect(parentOf("/")).toBe("/");
  });

  it("handles deep nesting", () => {
    expect(parentOf("/project1/geo1/particle1")).toBe("/project1/geo1");
  });
});
