import { describe, expect, it } from "vitest";
import {
  buildSectionView,
  capText,
  splitMarkdownSections,
} from "../../src/knowledge/docSections.js";

const DOC = [
  "Intro paragraph about the thing.",
  "",
  "## Setup",
  "Do the setup steps.",
  "",
  "## Usage",
  "Use it like this.",
  "",
  "### Advanced",
  "Deep dive content.",
].join("\n");

describe("splitMarkdownSections", () => {
  it("separates the intro from headed sections", () => {
    const { intro, sections } = splitMarkdownSections(DOC);
    expect(intro).toBe("Intro paragraph about the thing.");
    expect(sections.map((s) => s.title)).toEqual(["Setup", "Usage", "Advanced"]);
    expect(sections[1]?.content).toBe("Use it like this.");
  });

  it("treats a doc with no headings as pure intro", () => {
    const { intro, sections } = splitMarkdownSections("just text\nmore text");
    expect(sections).toHaveLength(0);
    expect(intro).toBe("just text\nmore text");
  });

  it("does not treat a # inside a fenced code block as a heading", () => {
    const doc = [
      "Intro",
      "",
      "## Real",
      "body",
      "",
      "```py",
      "# not a heading",
      "x = 1",
      "```",
    ].join("\n");
    const { sections } = splitMarkdownSections(doc);
    expect(sections.map((s) => s.title)).toEqual(["Real"]);
    expect(sections[0]?.content).toContain("# not a heading"); // stays inside the section body
  });
});

describe("capText", () => {
  it("leaves short text untouched", () => {
    expect(capText("hello", 100)).toEqual({ text: "hello", truncated: false });
  });

  it("truncates at a line boundary with a narrowing hint", () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const { text: out, truncated } = capText(text, 40);
    expect(truncated).toBe(true);
    expect(out).toContain("truncated at 40 chars");
    expect(out).toContain("`section`");
    // Truncation happens at a newline, so no partial line survives before the note.
    expect(out.split("\n\n")[0]?.endsWith("line 3") || out.includes("line 0")).toBe(true);
  });
});

describe("buildSectionView", () => {
  it("returns the whole small doc plus a section list by default", () => {
    const view = buildSectionView(DOC);
    expect(view.sections_available).toEqual(["Setup", "Usage", "Advanced"]);
    expect(view.content).toContain("Intro paragraph");
    expect(view.content).toContain("Use it like this."); // full body kept — it fits the cap
    expect(view.section).toBeUndefined();
  });

  it("collapses an oversized doc to intro + a drill-in menu", () => {
    const big = `Intro line.\n\n## A\n${"x".repeat(40)}\n\n## B\n${"y".repeat(40)}`;
    const view = buildSectionView(big, { maxChars: 60 });
    expect(view.sections_available).toEqual(["A", "B"]);
    expect(view.content).toContain("Sections available: A, B");
    expect(view.content).not.toContain("yyyy"); // section bodies dropped from the overview
  });

  it("drills into a requested section", () => {
    const view = buildSectionView(DOC, { section: "usage" });
    expect(view.section?.title).toBe("Usage");
    expect(view.content).toBe("Use it like this.");
  });

  it("falls back to full content (with the section list) when the section is unknown", () => {
    const view = buildSectionView(DOC, { section: "nope" });
    expect(view.section).toBeUndefined();
    expect(view.sections_available).toEqual(["Setup", "Usage", "Advanced"]);
    expect(view.content).toContain("Use it like this."); // small doc → full content
  });

  it("caps an oversized section", () => {
    const big = `## Big\n${"x".repeat(100)}`;
    const view = buildSectionView(big, { section: "Big", maxChars: 30 });
    expect(view.truncated).toBe(true);
    expect(view.content).toContain("truncated at 30 chars");
  });
});
