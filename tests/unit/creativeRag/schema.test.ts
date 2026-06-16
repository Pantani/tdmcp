import { describe, expect, it } from "vitest";
import {
  CreativeRagCardSchema,
  CreativeRagLicenseSchema,
  CreativeRagTypeSchema,
} from "../../../src/creativeRag/schema.js";

const MINIMAL = {
  schemaVersion: 1 as const,
  id: "abc",
  type: "artwork" as const,
  title: "Untitled",
  sourceUrl: "https://example.org/x",
  sourceName: "Seed",
  license: "CC0" as const,
  contentHash: "deadbeef",
};

describe("CreativeRagCardSchema", () => {
  it("defaults tools/tags/tdmcpAffordances to []", () => {
    const card = CreativeRagCardSchema.parse(MINIMAL);
    expect(card.tools).toEqual([]);
    expect(card.tags).toEqual([]);
    expect(card.tdmcpAffordances).toEqual([]);
  });

  it("rejects an unknown license", () => {
    expect(() => CreativeRagCardSchema.parse({ ...MINIMAL, license: "BananaLicense" })).toThrow();
  });

  it("rejects a missing schemaVersion", () => {
    const { schemaVersion: _omit, ...rest } = MINIMAL;
    expect(() => CreativeRagCardSchema.parse(rest)).toThrow();
  });

  it("rejects a schemaVersion that is not the literal 1", () => {
    expect(() => CreativeRagCardSchema.parse({ ...MINIMAL, schemaVersion: 2 })).toThrow();
  });

  it("keeps optional descriptive fields when present", () => {
    const card = CreativeRagCardSchema.parse({
      ...MINIMAL,
      artist: "A",
      year: 1923,
      palette: ["#fff"],
      body: "notes",
    });
    expect(card.artist).toBe("A");
    expect(card.year).toBe(1923);
    expect(card.palette).toEqual(["#fff"]);
    expect(card.body).toBe("notes");
  });
});

describe("enum schemas", () => {
  it("CreativeRagLicenseSchema accepts the canonical licenses", () => {
    for (const lic of ["CC0", "PublicDomain", "CC-BY", "CC-BY-SA", "Unknown", "Restricted"]) {
      expect(CreativeRagLicenseSchema.parse(lic)).toBe(lic);
    }
    expect(() => CreativeRagLicenseSchema.parse("Nope")).toThrow();
  });

  it("CreativeRagTypeSchema accepts the canonical types", () => {
    for (const t of ["project", "artist", "artwork", "technique", "cue_reference"]) {
      expect(CreativeRagTypeSchema.parse(t)).toBe(t);
    }
    expect(() => CreativeRagTypeSchema.parse("sculpture")).toThrow();
  });
});
