import { describe, expect, it } from "vitest";
import type { ProjectRagLicense } from "../../../src/projectRag/index.js";
import {
  canBridgeAnalyze,
  classifyFromSpdx,
  isCopyleftLicense,
  licenseScore,
  shouldIngestProjectCard,
  shouldStoreProjectBinary,
} from "../../../src/projectRag/index.js";

const PERMISSIVE: ProjectRagLicense[] = [
  "CC0",
  "PublicDomain",
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "MPL-2.0",
];

describe("projectRag licensePolicy.shouldStoreProjectBinary", () => {
  const allowlist: ProjectRagLicense[] = ["CC0", "PublicDomain", "MIT", "Apache-2.0"];

  it("allows binaries for allowlisted permissive licenses", () => {
    expect(shouldStoreProjectBinary("CC0", allowlist)).toBe(true);
    expect(shouldStoreProjectBinary("MIT", allowlist)).toBe(true);
  });

  it("refuses binaries for permissive licenses NOT in the allowlist", () => {
    expect(shouldStoreProjectBinary("BSD-3-Clause", allowlist)).toBe(false);
  });

  it("never stores Derivative-EULA / Proprietary-* / Unknown / Restricted even if allowlisted", () => {
    const wideAllow: ProjectRagLicense[] = [
      "Derivative-EULA",
      "Proprietary-Free",
      "Proprietary-Paid",
      "Unknown",
      "Restricted",
    ];
    for (const lic of wideAllow) {
      expect(shouldStoreProjectBinary(lic, wideAllow)).toBe(false);
    }
  });

  it("allows GPL/CC-BY binaries only when explicitly opted-in", () => {
    expect(shouldStoreProjectBinary("GPL-3.0", allowlist)).toBe(false);
    expect(shouldStoreProjectBinary("GPL-3.0", [...allowlist, "GPL-3.0"])).toBe(true);
    expect(shouldStoreProjectBinary("CC-BY", [...allowlist, "CC-BY"])).toBe(true);
  });
});

describe("projectRag licensePolicy.shouldIngestProjectCard", () => {
  it("ingests metadata for everything except Proprietary-Paid and Restricted", () => {
    for (const lic of [
      ...PERMISSIVE,
      "Derivative-EULA",
      "GPL-3.0",
      "Unknown",
    ] as ProjectRagLicense[]) {
      expect(shouldIngestProjectCard(lic)).toBe(true);
    }
    expect(shouldIngestProjectCard("Proprietary-Paid")).toBe(false);
    expect(shouldIngestProjectCard("Restricted")).toBe(false);
  });
});

describe("projectRag licensePolicy.isCopyleftLicense", () => {
  it("flags GPL / LGPL / AGPL families as copyleft", () => {
    for (const lic of [
      "GPL-2.0",
      "GPL-3.0",
      "LGPL-2.1",
      "LGPL-3.0",
      "AGPL-3.0",
    ] as ProjectRagLicense[]) {
      expect(isCopyleftLicense(lic)).toBe(true);
    }
    for (const lic of ["MIT", "Apache-2.0", "CC0", "Derivative-EULA"] as ProjectRagLicense[]) {
      expect(isCopyleftLicense(lic)).toBe(false);
    }
  });
});

describe("projectRag licensePolicy.canBridgeAnalyze", () => {
  it("denies bridge analyze for Proprietary-* / Unknown / Restricted", () => {
    expect(canBridgeAnalyze("Proprietary-Free")).toBe(false);
    expect(canBridgeAnalyze("Proprietary-Paid")).toBe(false);
    expect(canBridgeAnalyze("Unknown")).toBe(false);
    expect(canBridgeAnalyze("Restricted")).toBe(false);
  });
  it("allows bridge analyze for permissive + copyleft + Derivative-EULA + CC-BY*", () => {
    for (const lic of [
      "CC0",
      "MIT",
      "Apache-2.0",
      "GPL-3.0",
      "Derivative-EULA",
      "CC-BY",
      "CC-BY-SA",
    ] as ProjectRagLicense[]) {
      expect(canBridgeAnalyze(lic)).toBe(true);
    }
  });
});

describe("projectRag licensePolicy.licenseScore", () => {
  it("rank order matches the design matrix", () => {
    expect(licenseScore("CC0")).toBe(1.0);
    expect(licenseScore("MIT")).toBeGreaterThan(licenseScore("CC-BY"));
    expect(licenseScore("Derivative-EULA")).toBeGreaterThan(licenseScore("GPL-3.0"));
    expect(licenseScore("GPL-3.0")).toBeGreaterThan(licenseScore("Proprietary-Free"));
    expect(licenseScore("Proprietary-Free")).toBeGreaterThan(licenseScore("Unknown"));
    expect(licenseScore("Restricted")).toBe(0);
    expect(licenseScore("Proprietary-Paid")).toBe(0);
  });
});

describe("projectRag licensePolicy.classifyFromSpdx", () => {
  it("maps SPDX ids (case-insensitive) including -only/-or-later variants", () => {
    expect(classifyFromSpdx("MIT")).toBe("MIT");
    expect(classifyFromSpdx("mit")).toBe("MIT");
    expect(classifyFromSpdx("Apache-2.0")).toBe("Apache-2.0");
    expect(classifyFromSpdx("CC0-1.0")).toBe("CC0");
    expect(classifyFromSpdx("GPL-3.0-or-later")).toBe("GPL-3.0");
    expect(classifyFromSpdx("AGPL-3.0-only")).toBe("AGPL-3.0");
    expect(classifyFromSpdx("CC-BY-4.0")).toBe("CC-BY");
    expect(classifyFromSpdx("CC-BY-SA-4.0")).toBe("CC-BY-SA");
  });
  it("returns Unknown for unrecognised / empty input", () => {
    expect(classifyFromSpdx(undefined)).toBe("Unknown");
    expect(classifyFromSpdx("")).toBe("Unknown");
    expect(classifyFromSpdx("WTFPL")).toBe("Unknown");
  });
});
