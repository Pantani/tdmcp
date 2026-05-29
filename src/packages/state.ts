import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type PackagePaths, type PackageState, PackageStateSchema } from "./types.js";

export function emptyPackageState(): PackageState {
  return { version: 1, packages: [] };
}

export function readPackageState(paths: PackagePaths): PackageState {
  if (!existsSync(paths.installedRegistry)) return emptyPackageState();
  try {
    const raw = JSON.parse(readFileSync(paths.installedRegistry, "utf8")) as unknown;
    return PackageStateSchema.parse(raw);
  } catch {
    return emptyPackageState();
  }
}

export function writePackageState(paths: PackagePaths, state: PackageState): void {
  const parsed = PackageStateSchema.parse(state);
  mkdirSync(dirname(paths.installedRegistry), { recursive: true });
  writeFileSync(paths.installedRegistry, `${JSON.stringify(parsed, null, 2)}\n`);
}

export function upsertPackageState(
  paths: PackagePaths,
  record: PackageState["packages"][number],
): PackageState {
  const state = readPackageState(paths);
  const without = state.packages.filter((pkg) => pkg.id !== record.id);
  const next = { version: 1 as const, packages: [...without, record] };
  writePackageState(paths, next);
  return next;
}
