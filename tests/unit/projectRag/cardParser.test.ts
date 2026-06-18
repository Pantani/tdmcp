import { describe, expect, it } from "vitest";
import type { ProjectRagCard } from "../../../src/projectRag/index.js";
import {
  computeProjectContentHash,
  computeProjectId,
  parseProjectCard,
  serializeProjectCard,
} from "../../../src/projectRag/index.js";

function baseCard(overrides: Partial<ProjectRagCard> = {}): ProjectRagCard {
  const canonical = "github:torinmb/mediapipe-touchdesigner/src/MediaPipe.tox";
  const card: ProjectRagCard = {
    schemaVersion: 2,
    id: computeProjectId(canonical),
    kind: "project",
    type: "component",
    title: "MediaPipe TouchDesigner",
    tags: ["hand-tracking", "mediapipe"],
    contentHash: "",
    provenance: {
      sourceName: "github:torinmb/mediapipe-touchdesigner",
      sourceUrl: "https://github.com/torinmb/mediapipe-touchdesigner",
      canonical,
      commitOrVersion: "v1.2.3",
      pathInRepo: "src/MediaPipe.tox",
      fetchedAt: "2026-06-18T12:00:00Z",
    },
    license: "MIT",
    licenseConfidence: "spdx-detected",
    body: "MediaPipe TD wrapper for hand/pose/face landmarks.",
    operators: ["webrenderTOP", "scriptCHOP"],
    ...overrides,
  };
  return { ...card, contentHash: computeProjectContentHash(card) };
}

describe("projectRag cardParser round-trip", () => {
  it("serialize → parse is an identity for a full card", () => {
    const card = baseCard();
    const md = serializeProjectCard(card);
    const parsed = parseProjectCard(md);
    expect(parsed).toEqual(card);
  });

  it("body is preserved separately from frontmatter", () => {
    const card = baseCard({ body: "Multi-line\nbody\ntext\n" });
    const md = serializeProjectCard(card);
    expect(md).toContain("---\n");
    expect(md).toContain("Multi-line\nbody\ntext\n");
    expect(parseProjectCard(md).body).toBe("Multi-line\nbody\ntext\n");
  });

  it("rejects a card missing `provenance`", () => {
    const card = baseCard();
    const md = serializeProjectCard(card).replace(/provenance:[\s\S]*?fetchedAt:.*\n/, "");
    expect(() => parseProjectCard(md)).toThrow();
  });

  it("rejects a card missing `license`", () => {
    const card = baseCard();
    const md = serializeProjectCard(card).replace(/^license:.*\n/m, "");
    expect(() => parseProjectCard(md)).toThrow();
  });

  it("rejects a card with the wrong `kind` discriminator", () => {
    const card = baseCard();
    // biome-ignore lint/suspicious/noExplicitAny: deliberate bad input for parser test.
    const broken = { ...card, kind: "creative" } as any;
    expect(() => parseProjectCard(serializeProjectCard(broken))).toThrow();
  });
});

describe("projectRag cardParser content hash stability", () => {
  it("contentHash ignores volatile provenance.fetchedAt (cache-friendly)", () => {
    const c1 = baseCard({
      provenance: { ...baseCard().provenance, fetchedAt: "2026-06-18T00:00:00Z" },
    });
    const c2 = baseCard({
      provenance: { ...baseCard().provenance, fetchedAt: "2027-01-01T00:00:00Z" },
    });
    expect(computeProjectContentHash(c1)).toEqual(computeProjectContentHash(c2));
  });

  it("contentHash changes when meaningful fields change", () => {
    const a = baseCard();
    const b = baseCard({ title: "Different title" });
    expect(computeProjectContentHash(a)).not.toEqual(computeProjectContentHash(b));
  });
});

describe("projectRag computeProjectId", () => {
  it("is deterministic and depends only on the canonical string", () => {
    const a = computeProjectId("github:foo/bar/x.tox");
    const b = computeProjectId("github:foo/bar/x.tox");
    const c = computeProjectId("github:foo/bar/y.tox");
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(/^[0-9a-f]{64}$/.test(a)).toBe(true);
  });
});
