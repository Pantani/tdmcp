import { existsSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type PackageScope = "project" | "user";
export type PackageRootSource = "project" | "user-default" | "override";

export interface ResolvePackageStorageOptions {
  scope?: PackageScope;
  projectDir?: string;
  rootOverride?: string;
  cwd?: string;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}

export interface PackageStorageResolution {
  scope: PackageScope;
  root: string;
  source: PackageRootSource;
  projectDir?: string;
}

function assertDirectory(path: string, label: string): void {
  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(path);
  } catch {
    throw new Error(`${label} does not exist: ${path}`);
  }
  if (info.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link: ${path}`);
  if (!info.isDirectory()) throw new Error(`${label} must be a directory: ${path}`);
}

function assertExistingDirectoryOrAbsent(path: string, label: string): void {
  if (!existsSync(path)) return;
  const info = lstatSync(path);
  if (info.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link: ${path}`);
  if (!info.isDirectory()) throw new Error(`${label} must be a directory: ${path}`);
}

function assertNoParentTraversal(path: string, label: string): void {
  if (path.split(/[\\/]+/u).includes("..")) {
    throw new Error(`${label} must not contain parent traversal segments.`);
  }
}

function resolveProjectStorage(options: ResolvePackageStorageOptions): PackageStorageResolution {
  const rawProjectDir = options.projectDir?.trim();
  if (!rawProjectDir) {
    throw new Error("Project package scope requires an explicit project directory.");
  }
  assertNoParentTraversal(rawProjectDir, "Project directory");
  if (options.rootOverride) {
    throw new Error("packages_root cannot be combined with project package scope.");
  }
  const projectDir = resolve(options.cwd ?? process.cwd(), rawProjectDir);
  assertDirectory(projectDir, "Project directory");
  const metadataDir = join(projectDir, ".tdmcp");
  const root = join(metadataDir, "packages");
  assertExistingDirectoryOrAbsent(metadataDir, "Project .tdmcp directory");
  assertExistingDirectoryOrAbsent(root, "Project package root");
  return { scope: "project", root, source: "project", projectDir };
}

function resolveUserStorage(options: ResolvePackageStorageOptions): PackageStorageResolution {
  if (options.projectDir?.trim()) {
    throw new Error("project_dir is only valid with project package scope.");
  }
  const rawOverride = options.rootOverride?.trim();
  const configured = options.env?.TDMCP_PACKAGES_HOME?.trim();
  const unexpandedRoot =
    rawOverride || configured || join(options.homeDir ?? homedir(), ".tdmcp", "packages");
  const home = options.homeDir ?? homedir();
  const rawRoot =
    unexpandedRoot === "~"
      ? home
      : unexpandedRoot.startsWith("~/")
        ? join(home, unexpandedRoot.slice(2))
        : unexpandedRoot;
  const root = resolve(options.cwd ?? process.cwd(), rawRoot);
  assertExistingDirectoryOrAbsent(root, "Package root");
  return { scope: "user", root, source: rawOverride ? "override" : "user-default" };
}

export function resolvePackageStorage(
  options: ResolvePackageStorageOptions = {},
): PackageStorageResolution {
  return (options.scope ?? "user") === "project"
    ? resolveProjectStorage(options)
    : resolveUserStorage(options);
}
