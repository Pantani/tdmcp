import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  pnpm?: {
    overrides?: Record<string, string>;
    onlyBuiltDependencies?: string[];
  };
}

interface PnpmWorkspace {
  autoInstallPeers?: boolean;
}

function readRootPackageJson(): PackageJson {
  return JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as PackageJson;
}

function readPnpmWorkspace(): PnpmWorkspace {
  return parseYaml(readFileSync(join(root, "pnpm-workspace.yaml"), "utf8")) as PnpmWorkspace;
}

describe("package install metadata", () => {
  it("keeps hosted pnpm installs off known warning paths", () => {
    const packageJson = readRootPackageJson();
    const pnpmWorkspace = readPnpmWorkspace();

    expect(packageJson.dependencies).not.toHaveProperty("shader-park-core");
    expect(packageJson.devDependencies).toHaveProperty("search-insights", "^2.17.3");
    expect(packageJson.peerDependencies).toMatchObject({
      "shader-park-core": "^0.2.8",
    });
    expect(packageJson.peerDependenciesMeta).toMatchObject({
      "shader-park-core": { optional: true },
    });
    expect(packageJson.pnpm?.overrides).toMatchObject({
      "@bottobot/td-mcp>cheerio": "1.0.0-rc.12",
      vite: "6.4.3",
    });
    expect(packageJson.pnpm?.onlyBuiltDependencies).toEqual(["esbuild", "msw"]);
    expect(pnpmWorkspace.autoInstallPeers).toBe(false);
  });
});
