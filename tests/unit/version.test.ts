import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getVersion } from "../../src/utils/version.js";

describe("getVersion", () => {
  it("resolves the real package version, not the 0.0.0 fallback", () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
      version: string;
    };
    const version = getVersion();
    // Regression guard: the lookup matched on the unscoped name "tdmcp" while the
    // package ships as "@dpantani/tdmcp", so this used to fall through to "0.0.0".
    expect(version).toBe(pkg.version);
    expect(version).not.toBe("0.0.0");
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });
});
