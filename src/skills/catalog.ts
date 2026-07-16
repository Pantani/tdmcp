import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync, type Stats, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CanonicalSkillRecord,
  CURATED_AGENT_SKILLS,
  CURATED_SKILL_NAMES,
  type CuratedSkillName,
  SKILL_CATALOG_LIMITS,
  type SkillFileRecord,
  SkillManagerError,
} from "./types.js";

export interface BuildSkillCatalogOptions {
  sourceRoot?: string;
  bundleVersion?: string;
  selectedSkills?: readonly CuratedSkillName[];
}

export function resolveBundledSkillRoot(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const nestedModuleRoot = resolve(moduleDirectory, "../../skills/curated");
  const bundledRoot = resolve(moduleDirectory, "../skills/curated");
  // A tsup bundle runs at dist/index.js. Source and unbundled output run from a nested
  // src/skills, dist/skills, or dist/chunks directory and need the two-level candidate.
  const candidates =
    basename(moduleDirectory) === "dist"
      ? [bundledRoot, nestedModuleRoot]
      : [nestedModuleRoot, bundledRoot];
  return (
    candidates.find((candidate) => existsDirectory(candidate)) ?? candidates[0] ?? moduleDirectory
  );
}

function existsDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Locale-independent order used by manifests and reproducible bundles. */
export function compareUtf8Bytewise(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function assertSafeSkillRelativePath(value: string, label = "path"): void {
  const hasControlCharacter = [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
  if (
    value.length === 0 ||
    hasControlCharacter ||
    value.includes("\\") ||
    /^[a-zA-Z]:/u.test(value) ||
    value.startsWith("//") ||
    isAbsolute(value) ||
    value === "." ||
    value === ".." ||
    value.startsWith(`..${sep}`) ||
    value.split(/[\\/]/u).includes("..")
  ) {
    throw new SkillManagerError("UNSAFE_PATH", `${label} is not a safe relative path: ${value}`);
  }
}

function assertContained(root: string, candidate: string, label: string): void {
  const rel = relative(root, candidate);
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) return;
  throw new SkillManagerError("PATH_ESCAPE", `${label} escapes its catalog root.`);
}

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

interface CatalogAccumulator {
  records: SkillFileRecord[];
  directories: string[];
  treeBytes: number;
}

function assertCatalogEntryType(info: Stats, absolute: string): void {
  if (info.isSymbolicLink()) {
    throw new SkillManagerError("CATALOG_SYMLINK", `Bundled skill contains a symlink: ${absolute}`);
  }
  if (!info.isFile() && !info.isDirectory()) {
    throw new SkillManagerError(
      "CATALOG_SPECIAL_FILE",
      `Bundled skill contains a non-regular file: ${absolute}`,
    );
  }
}

function addCatalogFile(
  skillRoot: string,
  absolute: string,
  info: Stats,
  accumulator: CatalogAccumulator,
): void {
  const filePath = relative(skillRoot, absolute).split(sep).join("/");
  assertSafeSkillRelativePath(filePath, "Catalog file path");
  if (info.size > SKILL_CATALOG_LIMITS.maxFileBytes) {
    throw new SkillManagerError(
      "CATALOG_FILE_TOO_LARGE",
      `Bundled skill file exceeds ${SKILL_CATALOG_LIMITS.maxFileBytes} bytes: ${filePath}`,
    );
  }
  accumulator.treeBytes += info.size;
  if (accumulator.treeBytes > SKILL_CATALOG_LIMITS.maxTreeBytes) {
    throw new SkillManagerError(
      "CATALOG_TREE_TOO_LARGE",
      `Bundled skill tree exceeds ${SKILL_CATALOG_LIMITS.maxTreeBytes} bytes: ${skillRoot}`,
    );
  }
  accumulator.records.push({
    path: filePath,
    sha256: sha256(readFileSync(absolute)),
    size: info.size,
  });
  if (accumulator.records.length > SKILL_CATALOG_LIMITS.maxFilesPerSkill) {
    throw new SkillManagerError(
      "CATALOG_TOO_MANY_FILES",
      `Bundled skill exceeds ${SKILL_CATALOG_LIMITS.maxFilesPerSkill} files: ${skillRoot}`,
    );
  }
}

function visitCatalogDirectory(
  skillRoot: string,
  directory: string,
  accumulator: CatalogAccumulator,
): void {
  assertContained(skillRoot, directory, "Catalog directory");
  const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    compareUtf8Bytewise(a.name, b.name),
  );
  for (const entry of entries) {
    const absolute = join(directory, entry.name);
    const info = lstatSync(absolute);
    assertCatalogEntryType(info, absolute);
    if (info.isDirectory()) {
      accumulator.directories.push(relative(skillRoot, absolute).split(sep).join("/"));
      visitCatalogDirectory(skillRoot, absolute, accumulator);
      continue;
    }
    addCatalogFile(skillRoot, absolute, info, accumulator);
  }
}

function collectFiles(skillRoot: string): { files: SkillFileRecord[]; directories: string[] } {
  const records: SkillFileRecord[] = [];
  const directories: string[] = [];
  visitCatalogDirectory(skillRoot, skillRoot, { records, directories, treeBytes: 0 });
  records.sort((a, b) => compareUtf8Bytewise(a.path, b.path));
  if (!records.some((record) => record.path === "SKILL.md")) {
    throw new SkillManagerError("CATALOG_MISSING_ENTRYPOINT", `${skillRoot} has no SKILL.md.`);
  }
  directories.sort(compareUtf8Bytewise);
  return { files: records, directories };
}

export function hashCanonicalSkillFiles(files: readonly SkillFileRecord[]): string {
  const canonical = files.map((file) => `${file.path}\0${file.size}\0${file.sha256}`).join("\n");
  return sha256(canonical);
}

/**
 * Reads and validates the bounded bundled catalog. The returned records are stable inputs for
 * both the installer manifest and `build_agent_skill_bundle`.
 */
export function buildCanonicalSkillCatalog(
  options: BuildSkillCatalogOptions = {},
): CanonicalSkillRecord[] {
  const sourceRoot = resolve(options.sourceRoot ?? resolveBundledSkillRoot());
  const sourceInfo = lstatSync(sourceRoot);
  if (sourceInfo.isSymbolicLink() || !sourceInfo.isDirectory()) {
    throw new SkillManagerError(
      "INVALID_CATALOG_ROOT",
      `Invalid bundled skill root: ${sourceRoot}`,
    );
  }
  const realSourceRoot = realpathSync(sourceRoot);
  const selected = [...(options.selectedSkills ?? CURATED_SKILL_NAMES)].sort(compareUtf8Bytewise);
  if (selected.length > SKILL_CATALOG_LIMITS.maxSkills) {
    throw new SkillManagerError(
      "TOO_MANY_SKILLS",
      `At most ${SKILL_CATALOG_LIMITS.maxSkills} skills may be processed.`,
    );
  }
  return selected.map((name) => {
    const descriptor = CURATED_AGENT_SKILLS.find((candidate) => candidate.name === name);
    if (!descriptor) {
      throw new SkillManagerError("UNKNOWN_SKILL", `No bundled descriptor exists for ${name}.`);
    }
    const skillRoot = join(sourceRoot, name);
    const info = lstatSync(skillRoot);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new SkillManagerError("INVALID_SKILL_ROOT", `Invalid bundled skill directory: ${name}`);
    }
    const realSkillRoot = realpathSync(skillRoot);
    assertContained(realSourceRoot, realSkillRoot, `Bundled skill ${name}`);
    const { files, directories } = collectFiles(skillRoot);
    const actualPaths = files.map((file) => file.path);
    const expectedPaths = [...descriptor.files].sort(compareUtf8Bytewise);
    const expectedDirectories = [
      ...new Set(
        expectedPaths.flatMap((path) => {
          const parts = path.split("/");
          return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"));
        }),
      ),
    ].sort(compareUtf8Bytewise);
    if (
      actualPaths.length !== expectedPaths.length ||
      actualPaths.some((path, index) => path !== expectedPaths[index]) ||
      directories.length !== expectedDirectories.length ||
      directories.some((path, index) => path !== expectedDirectories[index])
    ) {
      throw new SkillManagerError(
        "CATALOG_FILE_SET_MISMATCH",
        `Bundled skill ${name} does not match its exact file allowlist.`,
      );
    }
    // Re-stat after traversal so an obvious source swap cannot silently change the recorded tree.
    if (!statSync(skillRoot).isDirectory()) {
      throw new SkillManagerError("INVALID_SKILL_ROOT", `Bundled skill disappeared: ${name}`);
    }
    return {
      name,
      relative_path: name,
      version: descriptor.version,
      tree_sha256: hashCanonicalSkillFiles(files),
      files,
      source_path: `skills/curated/${name}`,
    };
  });
}
