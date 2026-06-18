import { describe, expect, it } from "vitest";
import { buildProjectRagCrossLinkTip } from "../../../src/creativeRag/crossLink.js";

describe("buildProjectRagCrossLinkTip", () => {
  it("returns a tip when enabled, text mode, and resultCount=0", () => {
    const tip = buildProjectRagCrossLinkTip({
      query: "ocean",
      resultCount: 0,
      projectRagEnabled: true,
      json: false,
    });
    expect(tip).toBeDefined();
    expect(tip).toContain('"ocean"');
    expect(tip).toContain("tdmcp project-rag search");
  });

  it("returns a tip at the default threshold boundary (resultCount=2)", () => {
    const tip = buildProjectRagCrossLinkTip({
      query: "ocean",
      resultCount: 2,
      projectRagEnabled: true,
      json: false,
    });
    expect(tip).toBeDefined();
  });

  it("returns undefined when resultCount exceeds the default threshold", () => {
    const tip = buildProjectRagCrossLinkTip({
      query: "ocean",
      resultCount: 3,
      projectRagEnabled: true,
      json: false,
    });
    expect(tip).toBeUndefined();
  });

  it("returns undefined when JSON output mode is on", () => {
    const tip = buildProjectRagCrossLinkTip({
      query: "ocean",
      resultCount: 0,
      projectRagEnabled: true,
      json: true,
    });
    expect(tip).toBeUndefined();
  });

  it("returns undefined when Project RAG is not enabled", () => {
    const tip = buildProjectRagCrossLinkTip({
      query: "ocean",
      resultCount: 0,
      projectRagEnabled: false,
      json: false,
    });
    expect(tip).toBeUndefined();
  });

  it("embeds the query verbatim in the tip", () => {
    const tip = buildProjectRagCrossLinkTip({
      query: "kandinsky remix",
      resultCount: 1,
      projectRagEnabled: true,
      json: false,
    });
    expect(tip).toBeDefined();
    expect(tip).toContain("kandinsky remix");
  });

  it("returns undefined when the query is empty or whitespace", () => {
    expect(
      buildProjectRagCrossLinkTip({
        query: "",
        resultCount: 0,
        projectRagEnabled: true,
        json: false,
      }),
    ).toBeUndefined();
    expect(
      buildProjectRagCrossLinkTip({
        query: "   ",
        resultCount: 0,
        projectRagEnabled: true,
        json: false,
      }),
    ).toBeUndefined();
  });

  it("respects a custom threshold", () => {
    const within = buildProjectRagCrossLinkTip({
      query: "ocean",
      resultCount: 4,
      projectRagEnabled: true,
      json: false,
      threshold: 5,
    });
    expect(within).toBeDefined();

    const beyond = buildProjectRagCrossLinkTip({
      query: "ocean",
      resultCount: 6,
      projectRagEnabled: true,
      json: false,
      threshold: 5,
    });
    expect(beyond).toBeUndefined();
  });

  it("escapes embedded double quotes in the query", () => {
    const tip = buildProjectRagCrossLinkTip({
      query: 'foo "bar"',
      resultCount: 1,
      projectRagEnabled: true,
      json: false,
    });
    expect(tip).toBeDefined();
    expect(tip).toContain('\\"bar\\"');
  });
});
