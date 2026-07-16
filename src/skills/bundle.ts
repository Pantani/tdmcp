import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { buildCanonicalSkillCatalog, compareUtf8Bytewise } from "./catalog.js";
import { createDeterministicSkillZip } from "./deterministicZip.js";
import {
  type CanonicalSkillRecord,
  CURATED_AGENT_SKILLS,
  SKILL_CATALOG_LIMITS,
  SKILL_METADATA_MAX_BYTES,
  SKILL_OWNED_NAMESPACE,
  SKILL_PRODUCT,
  SKILL_SOURCE_KIND,
  type SkillHost,
  SkillManagerError,
} from "./types.js";

const BUNDLE_MANIFEST_FILENAME = "bundle.manifest.json";
const CHECKSUMS_FILENAME = "SHA256SUMS";
const BUNDLE_KIND = "tdmcp-agent-skill-bundle";
const ARCHIVE_FORMAT = "skill-zip-store-v1";
const BUNDLE_VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/u;
const DIRECTORY_MODE = 0o755;
const FILE_MODE = 0o644;

export interface BuildAgentSkillBundleOptions {
  repoRoot: string;
  outputDir: string;
  archiveMode: "none" | "skill";
  bundleVersion: string;
  overwrite: boolean;
  verifyReproducible: boolean;
}

export interface BuildAgentSkillBundleResult {
  status: "built" | "verified";
  output_dir: string;
  manifest_path: string;
  manifest_sha256: string;
  checksums_path: string;
  checksums_sha256: string;
  package_version: string;
  bundle_version: string;
  hosts: Array<{ host: SkillHost; skill_count: number }>;
  file_count: number;
  archive_count: number;
  reproducible_verified: boolean;
  side_effects: {
    installed: false;
    published: false;
    attached: false;
    released: false;
  };
}

interface BundleArchiveRecord {
  host: SkillHost;
  name: CanonicalSkillRecord["name"];
  path: string;
  sha256: string;
  size: number;
  format: typeof ARCHIVE_FORMAT;
}

interface BundleHostRecord {
  host: SkillHost;
  root: string;
  skills: CanonicalSkillRecord[];
}

interface BundleManifest {
  schema_version: 1;
  kind: typeof BUNDLE_KIND;
  product: typeof SKILL_PRODUCT;
  owned_namespace: typeof SKILL_OWNED_NAMESPACE;
  source: {
    kind: typeof SKILL_SOURCE_KIND;
    package_version: string;
    bundle_version: string;
  };
  hosts: BundleHostRecord[];
  archives: BundleArchiveRecord[];
}

interface StagedBundle {
  root: string;
  manifest: BundleManifest;
  manifestSha256: string;
  checksumsSha256: string;
  fileCount: number;
}

interface BundleBuildContext {
  realRepoRoot: string;
  outputDir: string;
  parent: string;
  packageVersion: string;
}

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function assertRegularDirectory(path: string, label: string): void {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new SkillManagerError("BUNDLE_INVALID_DIRECTORY", `${label} is not a regular directory.`);
  }
}

function assertNoSymlinkPath(candidate: string): void {
  const pathRoot = parse(candidate).root;
  const rel = relative(pathRoot, candidate);
  let current = pathRoot;
  for (const segment of rel.split(sep).filter(Boolean)) {
    current = join(current, segment);
    if (!existsSync(current)) break;
    const info = lstatSync(current);
    if (info.isSymbolicLink()) {
      throw new SkillManagerError("BUNDLE_SYMLINK_PATH", "Bundle output path contains a symlink.");
    }
  }
}

function assertSafeOutput(repoRoot: string, outputDir: string): void {
  const exactForbidden = [resolve("/"), resolve(homedir()), repoRoot];
  const protectedTrees = [
    join(repoRoot, "skills/curated"),
    join(repoRoot, ".agents"),
    join(repoRoot, ".claude"),
  ];
  if (
    exactForbidden.includes(outputDir) ||
    protectedTrees.some((path) => isContained(path, outputDir))
  ) {
    throw new SkillManagerError("BUNDLE_UNSAFE_OUTPUT", "Refusing to write to a protected path.");
  }
  assertNoSymlinkPath(outputDir);
  if (existsSync(outputDir)) {
    const info = lstatSync(outputDir);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new SkillManagerError(
        "BUNDLE_INVALID_OUTPUT",
        "Existing bundle output must be a regular directory.",
      );
    }
  }
}

export function readTdmcpPackageVersion(repoRoot: string): string {
  const packagePath = join(repoRoot, "package.json");
  const info = lstatSync(packagePath);
  if (info.isSymbolicLink() || !info.isFile() || info.size > SKILL_METADATA_MAX_BYTES) {
    throw new SkillManagerError("BUNDLE_INVALID_PACKAGE", "package.json is not a bounded file.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(packagePath, "utf8"));
  } catch {
    throw new SkillManagerError("BUNDLE_INVALID_PACKAGE", "package.json is invalid JSON.");
  }
  const version =
    parsed && typeof parsed === "object" && "version" in parsed
      ? (parsed as { version?: unknown }).version
      : undefined;
  if (typeof version !== "string" || !BUNDLE_VERSION_PATTERN.test(version)) {
    throw new SkillManagerError("BUNDLE_INVALID_PACKAGE", "package.json has an invalid version.");
  }
  return version;
}

function ensureDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: DIRECTORY_MODE });
  chmodSync(path, DIRECTORY_MODE);
}

function writeNormalizedFile(path: string, data: Buffer | string): void {
  ensureDirectory(dirname(path));
  writeFileSync(path, data, { flag: "wx", mode: FILE_MODE });
  chmodSync(path, FILE_MODE);
}

function selectedForHost(host: SkillHost, catalog: CanonicalSkillRecord[]): CanonicalSkillRecord[] {
  return catalog.filter((record) => {
    const descriptor = CURATED_AGENT_SKILLS.find((candidate) => candidate.name === record.name);
    if (!descriptor) {
      throw new SkillManagerError("BUNDLE_UNKNOWN_SKILL", `Missing descriptor: ${record.name}`);
    }
    return (descriptor.hosts as readonly SkillHost[]).includes(host);
  });
}

function copyHostPayload(
  stageRoot: string,
  sourceRoot: string,
  host: SkillHost,
  records: readonly CanonicalSkillRecord[],
): void {
  for (const record of records) {
    const sourceSkillRoot = join(sourceRoot, record.name);
    const targetSkillRoot = join(stageRoot, "hosts", host, "skills", "curated", record.name);
    for (const file of record.files) {
      const source = join(sourceSkillRoot, ...file.path.split("/"));
      const bytes = readFileSync(source);
      if (bytes.byteLength !== file.size || sha256(bytes) !== file.sha256) {
        throw new SkillManagerError(
          "BUNDLE_SOURCE_CHANGED",
          `Curated source changed while bundling: ${record.name}/${file.path}`,
        );
      }
      writeNormalizedFile(join(targetSkillRoot, ...file.path.split("/")), bytes);
    }
  }
}

function createArchives(
  stageRoot: string,
  hosts: readonly BundleHostRecord[],
): BundleArchiveRecord[] {
  const archives: BundleArchiveRecord[] = [];
  for (const host of hosts) {
    for (const skill of host.skills) {
      const entries = skill.files.map((file) => ({
        path: `${skill.name}/${file.path}`,
        data: readFileSync(
          join(
            stageRoot,
            "hosts",
            host.host,
            "skills",
            "curated",
            skill.name,
            ...file.path.split("/"),
          ),
        ),
      }));
      const bytes = createDeterministicSkillZip(entries);
      const archivePath = `archives/${host.host}/${skill.name}.skill`;
      writeNormalizedFile(join(stageRoot, ...archivePath.split("/")), bytes);
      archives.push({
        host: host.host,
        name: skill.name,
        path: archivePath,
        sha256: sha256(bytes),
        size: bytes.byteLength,
        format: ARCHIVE_FORMAT,
      });
    }
  }
  return archives.sort((left, right) => compareUtf8Bytewise(left.path, right.path));
}

function addRegularBundleEntry(
  root: string,
  absolute: string,
  omit: ReadonlySet<string>,
  files: string[],
): void {
  const info = lstatSync(absolute);
  if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) {
    throw new SkillManagerError("BUNDLE_SPECIAL_FILE", "Bundle contains a special file.");
  }
  if (info.isDirectory()) {
    visitBundleDirectory(root, absolute, omit, files);
    return;
  }
  const path = relative(root, absolute).split(sep).join("/");
  if (!omit.has(path)) files.push(path);
}

function visitBundleDirectory(
  root: string,
  directory: string,
  omit: ReadonlySet<string>,
  files: string[],
): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    addRegularBundleEntry(root, join(directory, entry.name), omit, files);
  }
}

function collectRegularFiles(root: string, omit = new Set<string>()): string[] {
  const files: string[] = [];
  visitBundleDirectory(root, root, omit, files);
  return files.sort(compareUtf8Bytewise);
}

function writeChecksums(stageRoot: string): string {
  const paths = collectRegularFiles(stageRoot, new Set([CHECKSUMS_FILENAME]));
  const content = paths
    .map((path) => `${sha256(readFileSync(join(stageRoot, path)))}  ${path}\n`)
    .join("");
  writeNormalizedFile(join(stageRoot, CHECKSUMS_FILENAME), content);
  for (const line of content.trimEnd().split("\n")) {
    const match = /^([a-f0-9]{64}) {2}(.+)$/u.exec(line);
    if (!match?.[1] || !match[2] || sha256(readFileSync(join(stageRoot, match[2]))) !== match[1]) {
      throw new SkillManagerError("BUNDLE_CHECKSUM_FAILED", "Staged bundle checksum failed.");
    }
  }
  return sha256(content);
}

function buildStage(
  stageRoot: string,
  repoRoot: string,
  packageVersion: string,
  bundleVersion: string,
  archiveMode: BuildAgentSkillBundleOptions["archiveMode"],
): StagedBundle {
  chmodSync(stageRoot, DIRECTORY_MODE);
  const sourceRoot = join(repoRoot, "skills", "curated");
  const catalog = buildCanonicalSkillCatalog({ sourceRoot, bundleVersion });
  if (catalog.length > SKILL_CATALOG_LIMITS.maxSkills) {
    throw new SkillManagerError(
      "BUNDLE_TOO_MANY_SKILLS",
      "Curated bundle exceeds its skill limit.",
    );
  }
  const hosts: BundleHostRecord[] = (["claude", "codex"] as const).map((host) => ({
    host,
    root: `hosts/${host}`,
    skills: selectedForHost(host, catalog),
  }));
  for (const host of hosts) copyHostPayload(stageRoot, sourceRoot, host.host, host.skills);
  const archives = archiveMode === "skill" ? createArchives(stageRoot, hosts) : [];
  const manifest: BundleManifest = {
    schema_version: 1,
    kind: BUNDLE_KIND,
    product: SKILL_PRODUCT,
    owned_namespace: SKILL_OWNED_NAMESPACE,
    source: {
      kind: SKILL_SOURCE_KIND,
      package_version: packageVersion,
      bundle_version: bundleVersion,
    },
    hosts,
    archives,
  };
  const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
  writeNormalizedFile(join(stageRoot, BUNDLE_MANIFEST_FILENAME), manifestBytes);
  const checksumsSha256 = writeChecksums(stageRoot);
  return {
    root: stageRoot,
    manifest,
    manifestSha256: sha256(manifestBytes),
    checksumsSha256,
    fileCount: collectRegularFiles(stageRoot).length,
  };
}

function compareStages(leftRoot: string, rightRoot: string): void {
  const left = collectRegularFiles(leftRoot);
  const right = collectRegularFiles(rightRoot);
  if (left.length !== right.length || left.some((path, index) => path !== right[index])) {
    throw new SkillManagerError("BUNDLE_NOT_REPRODUCIBLE", "Bundle file sets differ.");
  }
  for (const path of left) {
    if (
      sha256(readFileSync(join(leftRoot, path))) !== sha256(readFileSync(join(rightRoot, path)))
    ) {
      throw new SkillManagerError("BUNDLE_NOT_REPRODUCIBLE", `Bundle bytes differ: ${path}`);
    }
  }
}

function assertMarkedBundle(outputDir: string): void {
  const manifestPath = join(outputDir, BUNDLE_MANIFEST_FILENAME);
  if (!existsSync(manifestPath)) {
    throw new SkillManagerError(
      "BUNDLE_UNMARKED_OUTPUT",
      "Refusing to replace an unmarked directory.",
    );
  }
  const info = lstatSync(manifestPath);
  if (info.isSymbolicLink() || !info.isFile() || info.size > SKILL_METADATA_MAX_BYTES) {
    throw new SkillManagerError("BUNDLE_UNMARKED_OUTPUT", "Existing bundle marker is invalid.");
  }
  let marker: unknown;
  try {
    marker = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    throw new SkillManagerError("BUNDLE_UNMARKED_OUTPUT", "Existing bundle marker is invalid.");
  }
  if (
    !marker ||
    typeof marker !== "object" ||
    (marker as { kind?: unknown }).kind !== BUNDLE_KIND ||
    (marker as { product?: unknown }).product !== SKILL_PRODUCT
  ) {
    throw new SkillManagerError(
      "BUNDLE_UNMARKED_OUTPUT",
      "Existing directory is not a tdmcp bundle.",
    );
  }
}

function promote(stageRoot: string, outputDir: string, overwrite: boolean): void {
  if (!existsSync(outputDir)) {
    renameSync(stageRoot, outputDir);
    return;
  }
  if (!overwrite) {
    throw new SkillManagerError("BUNDLE_OUTPUT_EXISTS", "Bundle output already exists.");
  }
  assertMarkedBundle(outputDir);
  const backup = join(
    dirname(outputDir),
    `.${basename(outputDir)}.backup-${randomBytes(8).toString("hex")}`,
  );
  renameSync(outputDir, backup);
  try {
    renameSync(stageRoot, outputDir);
  } catch (error) {
    renameSync(backup, outputDir);
    throw error;
  }
  try {
    rmSync(backup, { recursive: true });
  } catch (error) {
    const failed = join(
      dirname(outputDir),
      `.${basename(outputDir)}.failed-${randomBytes(8).toString("hex")}`,
    );
    renameSync(outputDir, failed);
    renameSync(backup, outputDir);
    rmSync(failed, { recursive: true, force: true });
    throw error;
  }
}

function prepareBundleBuild(options: BuildAgentSkillBundleOptions): BundleBuildContext {
  if (!isAbsolute(options.repoRoot)) {
    throw new SkillManagerError("BUNDLE_REPO_NOT_ABSOLUTE", "repoRoot must be absolute.");
  }
  const repoRoot = resolve(options.repoRoot);
  assertRegularDirectory(repoRoot, "Repository root");
  const realRepoRoot = realpathSync(repoRoot);
  const outputDir = resolve(repoRoot, options.outputDir);
  if (options.archiveMode !== "none" && options.archiveMode !== "skill") {
    throw new SkillManagerError("BUNDLE_INVALID_ARCHIVE_MODE", "Invalid archive mode.");
  }
  if (!BUNDLE_VERSION_PATTERN.test(options.bundleVersion)) {
    throw new SkillManagerError("BUNDLE_INVALID_VERSION", "Invalid bundle version.");
  }
  assertSafeOutput(realRepoRoot, outputDir);
  if (existsSync(outputDir) && !options.overwrite) {
    throw new SkillManagerError("BUNDLE_OUTPUT_EXISTS", "Bundle output already exists.");
  }
  if (existsSync(outputDir) && options.overwrite) assertMarkedBundle(outputDir);
  const parent = dirname(outputDir);
  mkdirSync(parent, { recursive: true });
  assertNoSymlinkPath(parent);
  return {
    realRepoRoot,
    outputDir,
    parent,
    packageVersion: readTdmcpPackageVersion(realRepoRoot),
  };
}

function verifyReproducibleStage(
  options: BuildAgentSkillBundleOptions,
  context: BundleBuildContext,
  stageRoot: string,
): void {
  if (!options.verifyReproducible) return;
  const verificationRoot = mkdtempSync(
    join(context.parent, `.${basename(context.outputDir)}.verify-`),
  );
  try {
    buildStage(
      verificationRoot,
      context.realRepoRoot,
      context.packageVersion,
      options.bundleVersion,
      options.archiveMode,
    );
    compareStages(stageRoot, verificationRoot);
  } finally {
    rmSync(verificationRoot, { recursive: true, force: true });
  }
}

function bundleBuildResult(
  options: BuildAgentSkillBundleOptions,
  context: BundleBuildContext,
  staged: StagedBundle,
): BuildAgentSkillBundleResult {
  return {
    status: options.verifyReproducible ? "verified" : "built",
    output_dir: context.outputDir,
    manifest_path: join(context.outputDir, BUNDLE_MANIFEST_FILENAME),
    manifest_sha256: staged.manifestSha256,
    checksums_path: join(context.outputDir, CHECKSUMS_FILENAME),
    checksums_sha256: staged.checksumsSha256,
    package_version: context.packageVersion,
    bundle_version: options.bundleVersion,
    hosts: staged.manifest.hosts.map((host) => ({
      host: host.host,
      skill_count: host.skills.length,
    })),
    file_count: staged.fileCount,
    archive_count: staged.manifest.archives.length,
    reproducible_verified: options.verifyReproducible,
    side_effects: {
      installed: false,
      published: false,
      attached: false,
      released: false,
    },
  };
}

export function buildAgentSkillBundle(
  options: BuildAgentSkillBundleOptions,
): BuildAgentSkillBundleResult {
  const context = prepareBundleBuild(options);
  const stageRoot = mkdtempSync(join(context.parent, `.${basename(context.outputDir)}.stage-`));
  try {
    const staged = buildStage(
      stageRoot,
      context.realRepoRoot,
      context.packageVersion,
      options.bundleVersion,
      options.archiveMode,
    );
    verifyReproducibleStage(options, context, stageRoot);
    promote(stageRoot, context.outputDir, options.overwrite);
    return bundleBuildResult(options, context, staged);
  } finally {
    if (existsSync(stageRoot)) rmSync(stageRoot, { recursive: true, force: true });
  }
}
