import { describe, expect, it } from "vitest";
import {
  classifyArticLicense,
  classifyClevelandLicense,
  classifyMetLicense,
  classifyRijksLicense,
  shouldStoreBinary,
} from "../../../src/creativeRag/licensePolicy.js";

describe("shouldStoreBinary", () => {
  const allowlist = ["CC0", "PublicDomain"] as const;

  it("allows licenses in the allowlist", () => {
    expect(shouldStoreBinary("CC0", [...allowlist])).toBe(true);
    expect(shouldStoreBinary("PublicDomain", [...allowlist])).toBe(true);
  });

  it("rejects licenses not in the allowlist", () => {
    expect(shouldStoreBinary("Unknown", [...allowlist])).toBe(false);
    expect(shouldStoreBinary("Restricted", [...allowlist])).toBe(false);
    expect(shouldStoreBinary("CC-BY", [...allowlist])).toBe(false);
  });

  it("honors a custom allowlist", () => {
    expect(shouldStoreBinary("CC-BY", ["CC-BY"])).toBe(true);
    expect(shouldStoreBinary("CC0", ["CC-BY"])).toBe(false);
  });

  it("rejects everything against an empty allowlist", () => {
    expect(shouldStoreBinary("CC0", [])).toBe(false);
  });
});

describe("classifyArticLicense", () => {
  it("maps true to PublicDomain and false to Unknown", () => {
    expect(classifyArticLicense(true)).toBe("PublicDomain");
    expect(classifyArticLicense(false)).toBe("Unknown");
  });
});

describe("classifyMetLicense", () => {
  it("maps true to PublicDomain and false to Unknown", () => {
    expect(classifyMetLicense(true)).toBe("PublicDomain");
    expect(classifyMetLicense(false)).toBe("Unknown");
  });
});

describe("classifyClevelandLicense", () => {
  it("maps CC0 status to CC0 (case-insensitive)", () => {
    expect(classifyClevelandLicense("CC0")).toBe("CC0");
    expect(classifyClevelandLicense("cc0")).toBe("CC0");
  });

  it("maps a public-domain status to PublicDomain", () => {
    expect(classifyClevelandLicense("Public Domain")).toBe("PublicDomain");
  });

  it("maps copyrighted/missing to Unknown", () => {
    expect(classifyClevelandLicense("Copyrighted")).toBe("Unknown");
    expect(classifyClevelandLicense(undefined)).toBe("Unknown");
    expect(classifyClevelandLicense("")).toBe("Unknown");
  });
});

describe("classifyRijksLicense", () => {
  it("maps Creative Commons URIs (the real Rijksmuseum shape)", () => {
    expect(classifyRijksLicense("https://creativecommons.org/publicdomain/zero/1.0/")).toBe("CC0");
    expect(classifyRijksLicense("https://creativecommons.org/publicdomain/mark/1.0/")).toBe(
      "PublicDomain",
    );
    expect(classifyRijksLicense("https://creativecommons.org/licenses/by-sa/4.0/")).toBe(
      "CC-BY-SA",
    );
    expect(classifyRijksLicense("https://creativecommons.org/licenses/by/4.0/")).toBe("CC-BY");
    expect(classifyRijksLicense("https://example.org/all-rights")).toBe("Unknown");
  });

  it("maps CC0 text to CC0 (text fallback)", () => {
    expect(classifyRijksLicense("CC0 1.0 Universal")).toBe("CC0");
    expect(classifyRijksLicense("Creative Commons Zero")).toBe("CC0");
  });

  it("maps public-domain text to PublicDomain (text fallback)", () => {
    expect(classifyRijksLicense("Public Domain")).toBe("PublicDomain");
    expect(classifyRijksLicense("publicdomain/mark")).toBe("PublicDomain");
  });

  it("maps unknown or empty text to Unknown", () => {
    expect(classifyRijksLicense(undefined)).toBe("Unknown");
    expect(classifyRijksLicense("")).toBe("Unknown");
    expect(classifyRijksLicense("   ")).toBe("Unknown");
    expect(classifyRijksLicense("All rights reserved")).toBe("Unknown");
  });
});
