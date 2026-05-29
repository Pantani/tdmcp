import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { PackagePaths } from "./types.js";

export interface PackagePathOptions {
  rootDir?: string;
  env?: NodeJS.ProcessEnv;
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

export function defaultPackageRoot(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(expandHome(env.TDMCP_PACKAGES_HOME ?? "~/.tdmcp/packages"));
}

export function createPackagePaths(opts: PackagePathOptions = {}): PackagePaths {
  const root = resolve(expandHome(opts.rootDir ?? defaultPackageRoot(opts.env)));
  return {
    root,
    cache: join(root, "cache"),
    installRoot: join(root, "installed"),
    installedRegistry: join(root, "installed.json"),
  };
}

export function safePackageSegment(value: string): string {
  const segment = value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return segment || "package";
}
