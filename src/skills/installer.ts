import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  type Stats,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { atomicWriteFileSync } from "../utils/atomicWrite.js";
import { getVersion } from "../utils/version.js";
import {
  buildCanonicalSkillCatalog,
  compareUtf8Bytewise,
  hashCanonicalSkillFiles,
  resolveBundledSkillRoot,
} from "./catalog.js";
import {
  buildSkillManifest,
  manifestPathFor,
  readSkillManifest,
  serializeSkillManifest,
} from "./manifest.js";
import {
  type CanonicalSkillRecord,
  CURATED_SKILL_BUNDLE_VERSION,
  CURATED_SKILL_NAMES,
  type CuratedSkillName,
  isCuratedSkillName,
  type ManageAgentSkillsInput,
  type ManageAgentSkillsOptions,
  type ManageAgentSkillsResult,
  SKILL_CATALOG_LIMITS,
  SKILL_METADATA_MAX_BYTES,
  SkillManagerError,
  type SkillManifest,
  type SkillOperation,
  type SkillState,
  type SkillStatus,
} from "./types.js";

const TRANSACTION_PREFIX = ".tdmcp-skills-txn-";
const TRANSACTION_MARKER = "transaction.json";

interface TransactionOperation {
  operation: "install" | "update" | "remove";
  name: CuratedSkillName;
  had_destination: boolean;
}

interface TransactionMarker {
  schema_version: 1;
  prior_manifest: string | null;
  next_manifest: string;
  operations: TransactionOperation[];
}

interface PlanEntry {
  operation: SkillOperation;
  state: SkillStatus;
  source: CanonicalSkillRecord;
  owned?: CanonicalSkillRecord;
  conflict?: string;
}

type AppliedPlanOptions = ManageAgentSkillsOptions & {
  packageVersion: string;
  bundleVersion: string;
  now: () => Date;
  randomId: () => string;
};

function sha256ForFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function assertContained(root: string, candidate: string, label: string): void {
  const rel = relative(root, candidate);
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) return;
  throw new SkillManagerError("PATH_ESCAPE", `${label} escapes the skill root.`);
}

function selectedSkillNames(input: ManageAgentSkillsInput): CuratedSkillName[] {
  const raw = input.skills ?? [...CURATED_SKILL_NAMES];
  if (raw.length > SKILL_CATALOG_LIMITS.maxSkills) {
    throw new SkillManagerError(
      "TOO_MANY_SKILLS",
      `At most ${SKILL_CATALOG_LIMITS.maxSkills} skills may be managed.`,
    );
  }
  const selected = new Set<CuratedSkillName>();
  for (const name of raw) {
    if (!isCuratedSkillName(name)) {
      throw new SkillManagerError("UNKNOWN_SKILL", `Unknown bundled tdmcp skill: ${name}`);
    }
    if (selected.has(name)) {
      throw new SkillManagerError("DUPLICATE_SKILL", `Skill selected more than once: ${name}`);
    }
    selected.add(name);
  }
  return [...selected].sort(compareUtf8Bytewise);
}

function resolveProjectSkillTargetRoot(
  input: Pick<ManageAgentSkillsInput, "host" | "scope" | "project_root">,
  options: ManageAgentSkillsOptions,
): string {
  const projectRoot = input.project_root ?? options.projectRoot;
  if (!projectRoot) {
    throw new SkillManagerError(
      "PROJECT_ROOT_REQUIRED",
      "project_root is required for project-scoped skill management.",
    );
  }
  if (!isAbsolute(projectRoot)) {
    throw new SkillManagerError("PROJECT_ROOT_NOT_ABSOLUTE", "project_root must be absolute.");
  }
  return join(resolve(projectRoot), input.host === "codex" ? ".agents/skills" : ".claude/skills");
}

function resolveUserSkillTargetRoot(
  input: Pick<ManageAgentSkillsInput, "host">,
  options: ManageAgentSkillsOptions,
): string {
  const home = resolve(options.homeDir ?? homedir());
  if (input.host === "codex") {
    const codexHome = options.codexHome ?? process.env.CODEX_HOME;
    if (codexHome && !isAbsolute(codexHome)) {
      throw new SkillManagerError("CODEX_HOME_NOT_ABSOLUTE", "CODEX_HOME must be absolute.");
    }
    return join(resolve(codexHome ?? join(home, ".codex")), "skills");
  }
  return join(home, ".claude", "skills");
}

export function resolveSkillTargetRoot(
  input: Pick<ManageAgentSkillsInput, "host" | "scope" | "project_root">,
  options: ManageAgentSkillsOptions = {},
): string {
  return input.scope === "project"
    ? resolveProjectSkillTargetRoot(input, options)
    : resolveUserSkillTargetRoot(input, options);
}

interface InstalledTreeAccumulator {
  files: Array<{ path: string; sha256: string; size: number }>;
  treeBytes: number;
}

function assertInstalledEntryType(info: Stats): void {
  if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) {
    throw new SkillManagerError("OWNED_DRIFT", "owned destination contains a special file");
  }
}

function addInstalledFile(
  root: string,
  absolute: string,
  info: Stats,
  accumulator: InstalledTreeAccumulator,
): void {
  if (info.size > SKILL_CATALOG_LIMITS.maxFileBytes) {
    throw new SkillManagerError("OWNED_DRIFT", "owned destination contains an oversized file");
  }
  accumulator.treeBytes += info.size;
  if (accumulator.treeBytes > SKILL_CATALOG_LIMITS.maxTreeBytes) {
    throw new SkillManagerError("OWNED_DRIFT", "owned destination exceeds the tree limit");
  }
  accumulator.files.push({
    path: relative(root, absolute).split(sep).join("/"),
    sha256: sha256ForFile(absolute),
    size: info.size,
  });
  if (accumulator.files.length > SKILL_CATALOG_LIMITS.maxFilesPerSkill) {
    throw new SkillManagerError("OWNED_DRIFT", "owned destination exceeds the file limit");
  }
}

function visitInstalledDirectory(
  root: string,
  directory: string,
  accumulator: InstalledTreeAccumulator,
): void {
  assertContained(root, directory, "Installed directory");
  const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    compareUtf8Bytewise(a.name, b.name),
  );
  for (const entry of entries) {
    const absolute = join(directory, entry.name);
    const info = lstatSync(absolute);
    assertInstalledEntryType(info);
    if (info.isDirectory()) {
      visitInstalledDirectory(root, absolute, accumulator);
      continue;
    }
    addInstalledFile(root, absolute, info, accumulator);
  }
}

function scanInstalledTree(path: string): { treeSha256?: string; error?: string } {
  if (!existsSync(path)) return {};
  try {
    const rootInfo = lstatSync(path);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
      return { error: "owned destination is not a regular directory" };
    }
    const files: Array<{ path: string; sha256: string; size: number }> = [];
    visitInstalledDirectory(path, path, { files, treeBytes: 0 });
    files.sort((a, b) => compareUtf8Bytewise(a.path, b.path));
    return { treeSha256: hashCanonicalSkillFiles(files) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function inspectSkill(
  targetRoot: string,
  source: CanonicalSkillRecord,
  owned: CanonicalSkillRecord | undefined,
): SkillStatus {
  const path = join(targetRoot, source.relative_path);
  const exists = existsSync(path);
  if (!owned) {
    return {
      name: source.name,
      path,
      state: exists ? "unowned_conflict" : "not_installed",
      source_sha256: source.tree_sha256,
      owned: false,
    };
  }
  if (!exists) {
    return {
      name: source.name,
      path,
      state: "missing",
      source_sha256: source.tree_sha256,
      installed_sha256: owned.tree_sha256,
      owned: true,
    };
  }
  const actual = scanInstalledTree(path);
  if (!actual.treeSha256 || actual.error || actual.treeSha256 !== owned.tree_sha256) {
    return {
      name: source.name,
      path,
      state: "drifted",
      source_sha256: source.tree_sha256,
      installed_sha256: actual.treeSha256,
      owned: true,
    };
  }
  return {
    name: source.name,
    path,
    state: source.tree_sha256 === owned.tree_sha256 ? "installed" : "outdated",
    source_sha256: source.tree_sha256,
    installed_sha256: actual.treeSha256,
    owned: true,
  };
}

function mutationForState(
  action: ManageAgentSkillsInput["action"],
  state: SkillState,
  forceOwnedDrift: boolean,
): { operation: SkillOperation["operation"]; conflict?: string } {
  if (action === "status") return { operation: "unchanged" };
  if (state === "unowned_conflict") {
    return { operation: "unchanged", conflict: "destination exists without manifest ownership" };
  }
  if (state === "drifted" && !forceOwnedDrift) {
    return { operation: "unchanged", conflict: "owned content drifted; explicit force required" };
  }
  if (action === "uninstall") {
    if (state === "not_installed") return { operation: "unchanged" };
    return { operation: "remove" };
  }
  if (state === "installed") return { operation: "unchanged" };
  if (state === "not_installed" || state === "missing") return { operation: "install" };
  return { operation: "update" };
}

function buildPlan(
  input: ManageAgentSkillsInput,
  targetRoot: string,
  catalog: CanonicalSkillRecord[],
  manifest: SkillManifest | null,
): PlanEntry[] {
  const ownedByName = new Map(manifest?.skills.map((skill) => [skill.name, skill]));
  return catalog.map((source) => {
    const owned = ownedByName.get(source.name);
    const state = inspectSkill(targetRoot, source, owned);
    const choice = mutationForState(input.action, state.state, input.force_owned_drift);
    const fromSha = owned?.tree_sha256;
    const operation: SkillOperation = {
      operation: choice.operation,
      name: source.name,
      path: state.path,
      ...(fromSha ? { from_sha256: fromSha } : {}),
      ...(choice.operation === "install" || choice.operation === "update"
        ? { to_sha256: source.tree_sha256 }
        : {}),
    };
    return {
      operation,
      state,
      source,
      owned,
      ...(choice.conflict ? { conflict: choice.conflict } : {}),
    };
  });
}

function transactionDirectories(targetRoot: string): string[] {
  if (!existsSync(targetRoot)) return [];
  const targetInfo = lstatSync(targetRoot);
  if (targetInfo.isSymbolicLink() || !targetInfo.isDirectory()) {
    throw new SkillManagerError(
      "INVALID_TARGET_ROOT",
      "The selected skill target root is not a regular directory.",
    );
  }
  return readdirSync(targetRoot, { withFileTypes: true })
    .filter((entry) => entry.name.startsWith(TRANSACTION_PREFIX))
    .map((entry) => {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new SkillManagerError(
          "INVALID_TRANSACTION",
          `Invalid interrupted transaction marker: ${entry.name}`,
        );
      }
      return join(targetRoot, entry.name);
    })
    .sort(compareUtf8Bytewise);
}

function readTransactionMarker(transactionRoot: string): TransactionMarker {
  const markerPath = join(transactionRoot, TRANSACTION_MARKER);
  if (!existsSync(markerPath)) {
    throw new SkillManagerError(
      "INVALID_TRANSACTION",
      "Interrupted transaction has no safe marker.",
    );
  }
  const markerInfo = lstatSync(markerPath);
  if (
    markerInfo.isSymbolicLink() ||
    !markerInfo.isFile() ||
    markerInfo.size > SKILL_METADATA_MAX_BYTES
  ) {
    throw new SkillManagerError(
      "INVALID_TRANSACTION",
      "Interrupted transaction marker is not a bounded regular file.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(markerPath, "utf8"));
  } catch {
    throw new SkillManagerError(
      "INVALID_TRANSACTION",
      "Interrupted transaction marker is invalid.",
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new SkillManagerError(
      "INVALID_TRANSACTION",
      "Interrupted transaction marker is invalid.",
    );
  }
  const value = parsed as Record<string, unknown>;
  if (
    value.schema_version !== 1 ||
    (value.prior_manifest !== null && typeof value.prior_manifest !== "string") ||
    typeof value.next_manifest !== "string" ||
    !Array.isArray(value.operations)
  ) {
    throw new SkillManagerError(
      "INVALID_TRANSACTION",
      "Interrupted transaction marker is invalid.",
    );
  }
  const operations: TransactionOperation[] = value.operations.map((raw) => {
    if (!raw || typeof raw !== "object") {
      throw new SkillManagerError("INVALID_TRANSACTION", "Interrupted operation is invalid.");
    }
    const operation = raw as Record<string, unknown>;
    if (
      (operation.operation !== "install" &&
        operation.operation !== "update" &&
        operation.operation !== "remove") ||
      typeof operation.name !== "string" ||
      !isCuratedSkillName(operation.name) ||
      typeof operation.had_destination !== "boolean"
    ) {
      throw new SkillManagerError("INVALID_TRANSACTION", "Interrupted operation is invalid.");
    }
    return {
      operation: operation.operation,
      name: operation.name,
      had_destination: operation.had_destination,
    };
  });
  return {
    schema_version: 1,
    prior_manifest: value.prior_manifest as string | null,
    next_manifest: value.next_manifest,
    operations,
  };
}

function recoverTransaction(targetRoot: string, transactionRoot: string): void {
  assertContained(targetRoot, transactionRoot, "Transaction directory");
  const marker = readTransactionMarker(transactionRoot);
  const manifestPath = manifestPathFor(targetRoot);
  const currentManifest = existsSync(manifestPath) ? readFileSync(manifestPath, "utf8") : null;
  if (currentManifest === marker.next_manifest) {
    rmSync(transactionRoot, { recursive: true, force: true });
    return;
  }
  if (currentManifest !== marker.prior_manifest) {
    throw new SkillManagerError(
      "TRANSACTION_MANIFEST_CONFLICT",
      "Interrupted transaction cannot be recovered because its manifest changed.",
    );
  }
  for (const operation of [...marker.operations].reverse()) {
    const destination = join(targetRoot, operation.name);
    const backup = join(transactionRoot, "backups", operation.name);
    if (existsSync(backup)) {
      rmSync(destination, { recursive: true, force: true });
      renameSync(backup, destination);
    } else if (operation.operation === "install" && !operation.had_destination) {
      rmSync(destination, { recursive: true, force: true });
    }
  }
  rmSync(transactionRoot, { recursive: true, force: true });
}

export function recoverInterruptedSkillTransactions(targetRoot: string): number {
  const transactions = transactionDirectories(targetRoot);
  for (const transaction of transactions) recoverTransaction(targetRoot, transaction);
  return transactions.length;
}

function copySkillToStage(
  sourceRoot: string,
  transactionRoot: string,
  skill: CanonicalSkillRecord,
): void {
  const sourceSkillRoot = join(sourceRoot, skill.name);
  const stagedSkillRoot = join(transactionRoot, "staged", skill.name);
  mkdirSync(stagedSkillRoot, { recursive: true });
  for (const file of skill.files) {
    const source = join(sourceSkillRoot, ...file.path.split("/"));
    const destination = join(stagedSkillRoot, ...file.path.split("/"));
    assertContained(sourceSkillRoot, source, "Catalog file");
    assertContained(stagedSkillRoot, destination, "Staged file");
    const content = readFileSync(source);
    const currentHash = createHash("sha256").update(content).digest("hex");
    if (content.byteLength !== file.size || currentHash !== file.sha256) {
      throw new SkillManagerError(
        "CATALOG_CHANGED",
        `Bundled skill changed while staging: ${skill.name}/${file.path}`,
      );
    }
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, content);
  }
}

function nextManifestFor(
  input: ManageAgentSkillsInput,
  targetRoot: string,
  prior: SkillManifest | null,
  entries: PlanEntry[],
  options: Required<Pick<ManageAgentSkillsOptions, "packageVersion" | "bundleVersion" | "now">>,
): SkillManifest {
  const skills = new Map(prior?.skills.map((skill) => [skill.name, skill]));
  for (const entry of entries) {
    if (entry.operation.operation === "install" || entry.operation.operation === "update") {
      skills.set(entry.source.name, entry.source);
    } else if (entry.operation.operation === "remove") {
      skills.delete(entry.source.name);
    }
  }
  return buildSkillManifest({
    prior,
    host: input.host,
    scope: input.scope,
    targetRoot,
    packageVersion: options.packageVersion,
    bundleVersion: options.bundleVersion,
    now: options.now().toISOString(),
    skills: [...skills.values()],
  });
}

function assertValidMutationTarget(targetRoot: string): void {
  if (!existsSync(targetRoot)) return;
  const targetInfo = lstatSync(targetRoot);
  if (targetInfo.isSymbolicLink() || !targetInfo.isDirectory()) {
    throw new SkillManagerError(
      "INVALID_TARGET_ROOT",
      "The selected skill target root is not a regular directory.",
    );
  }
}

function createTransactionRoot(targetRoot: string, options: AppliedPlanOptions): string {
  assertValidMutationTarget(targetRoot);
  mkdirSync(targetRoot, { recursive: true });
  const transactionRoot = join(
    targetRoot,
    `${TRANSACTION_PREFIX}${process.pid}-${options.randomId()}`,
  );
  if (existsSync(transactionRoot)) {
    throw new SkillManagerError("TRANSACTION_COLLISION", "Transaction id already exists.");
  }
  mkdirSync(join(transactionRoot, "staged"), { recursive: true });
  mkdirSync(join(transactionRoot, "backups"), { recursive: true });
  return transactionRoot;
}

function transactionMarkerFor(
  mutations: PlanEntry[],
  priorManifestRaw: string | null,
  nextManifest: string,
): TransactionMarker {
  return {
    schema_version: 1,
    prior_manifest: priorManifestRaw,
    next_manifest: nextManifest,
    operations: mutations.map((entry) => ({
      operation: entry.operation.operation as TransactionOperation["operation"],
      name: entry.source.name,
      had_destination: existsSync(entry.state.path),
    })),
  };
}

function stagePlanMutations(
  mutations: readonly PlanEntry[],
  sourceRoot: string,
  transactionRoot: string,
): void {
  for (const entry of mutations) {
    if (entry.operation.operation !== "remove") {
      copySkillToStage(sourceRoot, transactionRoot, entry.source);
    }
  }
}

function swapPlanMutations(
  mutations: readonly PlanEntry[],
  transactionRoot: string,
  options: AppliedPlanOptions,
): void {
  for (const entry of mutations) {
    const destination = entry.state.path;
    const backup = join(transactionRoot, "backups", entry.source.name);
    if (existsSync(destination)) renameSync(destination, backup);
    if (entry.operation.operation !== "remove") {
      renameSync(join(transactionRoot, "staged", entry.source.name), destination);
    }
    options.onTransactionStep?.("after_swap", entry.source.name);
  }
}

function verifyPlanMutation(entry: PlanEntry): void {
  if (entry.operation.operation === "remove") {
    if (existsSync(entry.state.path)) {
      throw new SkillManagerError(
        "APPLY_VERIFICATION_FAILED",
        `Removed skill still exists: ${entry.source.name}`,
      );
    }
    return;
  }
  const actual = scanInstalledTree(entry.state.path);
  if (actual.treeSha256 !== entry.source.tree_sha256) {
    throw new SkillManagerError(
      "APPLY_VERIFICATION_FAILED",
      `Installed skill did not match its source: ${entry.source.name}`,
    );
  }
}

function verifyPlanMutations(mutations: readonly PlanEntry[]): void {
  for (const entry of mutations) verifyPlanMutation(entry);
}

function removeCommittedTransaction(transactionRoot: string): void {
  try {
    rmSync(transactionRoot, { recursive: true, force: true });
  } catch {
    // The manifest is already committed. The next applied run safely cleans this marker.
  }
}

function rollbackFailedTransaction(
  targetRoot: string,
  transactionRoot: string,
  markerWritten: boolean,
  error: unknown,
): never {
  if (!markerWritten || !existsSync(transactionRoot)) {
    rmSync(transactionRoot, { recursive: true, force: true });
    throw error;
  }
  try {
    recoverTransaction(targetRoot, transactionRoot);
  } catch (rollbackError) {
    const message = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
    throw new SkillManagerError(
      "ROLLBACK_FAILED",
      `Skill transaction failed and rollback also failed: ${message}`,
    );
  }
  throw error;
}

function applyPlan(
  input: ManageAgentSkillsInput,
  targetRoot: string,
  sourceRoot: string,
  priorManifest: SkillManifest | null,
  priorManifestRaw: string | null,
  entries: PlanEntry[],
  options: AppliedPlanOptions,
): SkillOperation[] {
  const mutations = entries.filter((entry) => entry.operation.operation !== "unchanged");
  if (mutations.length === 0) return [];
  const transactionRoot = createTransactionRoot(targetRoot, options);
  const nextManifest = serializeSkillManifest(
    nextManifestFor(input, targetRoot, priorManifest, mutations, options),
  );
  const marker = transactionMarkerFor(mutations, priorManifestRaw, nextManifest);

  let markerWritten = false;
  try {
    stagePlanMutations(mutations, sourceRoot, transactionRoot);
    options.onTransactionStep?.("after_staging");
    atomicWriteFileSync(join(transactionRoot, TRANSACTION_MARKER), `${JSON.stringify(marker)}\n`);
    markerWritten = true;
    options.onTransactionStep?.("before_swap");
    swapPlanMutations(mutations, transactionRoot, options);
    verifyPlanMutations(mutations);
    options.onTransactionStep?.("before_manifest");
    atomicWriteFileSync(manifestPathFor(targetRoot), nextManifest);
    removeCommittedTransaction(transactionRoot);
    return mutations.map((entry) => entry.operation);
  } catch (error) {
    return rollbackFailedTransaction(targetRoot, transactionRoot, markerWritten, error);
  }
}

type ManageResultBase = Omit<ManageAgentSkillsResult, "status" | "applied">;

interface ResolvedManagementContext extends AppliedPlanOptions {
  targetRoot: string;
  sourceRoot: string;
  dryRun: boolean;
}

interface PendingTransactionResolution {
  warnings: string[];
  result?: ManageAgentSkillsResult;
}

interface PreparedManagementPlan {
  catalog: CanonicalSkillRecord[];
  manifest: SkillManifest | null;
  manifestRaw: string | null;
  entries: PlanEntry[];
  base: ManageResultBase;
}

function resolveManagementContext(
  input: ManageAgentSkillsInput,
  options: ManageAgentSkillsOptions,
): ResolvedManagementContext {
  return {
    ...options,
    targetRoot: resolveSkillTargetRoot(input, options),
    sourceRoot: resolve(options.sourceRoot ?? resolveBundledSkillRoot()),
    packageVersion: options.packageVersion ?? getVersion(),
    bundleVersion: options.bundleVersion ?? CURATED_SKILL_BUNDLE_VERSION,
    now: options.now ?? (() => new Date()),
    randomId: options.randomId ?? (() => randomBytes(8).toString("hex")),
    dryRun: input.action === "status" ? true : input.dry_run,
  };
}

function pendingTransactionConflict(
  input: ManageAgentSkillsInput,
  context: ResolvedManagementContext,
  pendingCount: number,
): ManageAgentSkillsResult {
  return {
    action: input.action,
    status: "conflict",
    dry_run: true,
    host: input.host,
    scope: input.scope,
    target_root: context.targetRoot,
    manifest_path: manifestPathFor(context.targetRoot),
    source_version: context.packageVersion,
    planned: [],
    applied: [],
    skills: [],
    warnings: [
      `${pendingCount} interrupted skill transaction(s) require an explicit applied run for recovery.`,
    ],
  };
}

function resolvePendingTransactions(
  input: ManageAgentSkillsInput,
  context: ResolvedManagementContext,
): PendingTransactionResolution {
  const pending = transactionDirectories(context.targetRoot);
  if (pending.length === 0) return { warnings: [] };
  if (context.dryRun) {
    return { warnings: [], result: pendingTransactionConflict(input, context, pending.length) };
  }
  const recovered = recoverInterruptedSkillTransactions(context.targetRoot);
  return { warnings: [`Recovered ${recovered} interrupted skill transaction(s).`] };
}

function prepareManagementPlan(
  input: ManageAgentSkillsInput,
  context: ResolvedManagementContext,
  selected: CuratedSkillName[],
  warnings: string[],
): PreparedManagementPlan {
  const catalog = buildCanonicalSkillCatalog({
    sourceRoot: context.sourceRoot,
    bundleVersion: context.bundleVersion,
    selectedSkills: selected,
  });
  const { manifest, raw: manifestRaw } = readSkillManifest(
    context.targetRoot,
    input.host,
    input.scope,
  );
  const entries = buildPlan(input, context.targetRoot, catalog, manifest);
  const conflicts = entries.filter((entry) => entry.conflict);
  for (const conflict of conflicts) {
    warnings.push(`${conflict.source.name}: ${conflict.conflict}`);
  }
  return {
    catalog,
    manifest,
    manifestRaw,
    entries,
    base: {
      action: input.action,
      dry_run: context.dryRun,
      host: input.host,
      scope: input.scope,
      target_root: context.targetRoot,
      manifest_path: manifestPathFor(context.targetRoot),
      source_version: context.packageVersion,
      planned: entries.map((entry) => entry.operation),
      skills: entries.map((entry) => entry.state),
      warnings,
    },
  };
}

function plannedManagementResult(
  input: ManageAgentSkillsInput,
  context: ResolvedManagementContext,
  plan: PreparedManagementPlan,
): ManageAgentSkillsResult | null {
  if (plan.entries.some((entry) => entry.conflict)) {
    return { ...plan.base, status: "conflict", applied: [] };
  }
  const hasMutation = plan.entries.some((entry) => entry.operation.operation !== "unchanged");
  if (input.action === "status" || !hasMutation) {
    return { ...plan.base, status: "no_change", applied: [] };
  }
  if (context.dryRun) return { ...plan.base, status: "planned", applied: [] };
  return null;
}

function confirmedManagementResult(
  input: ManageAgentSkillsInput,
  plan: PreparedManagementPlan,
  applied: SkillOperation[],
  confirmedEntries: PlanEntry[],
): ManageAgentSkillsResult {
  const expectedState = input.action === "uninstall" ? "not_installed" : "installed";
  const skills = confirmedEntries.map((entry) => entry.state);
  if (confirmedEntries.some((entry) => entry.state.state !== expectedState)) {
    return {
      ...plan.base,
      status: "failed",
      applied,
      skills,
      warnings: [
        ...plan.base.warnings,
        "Applied skill state could not be confirmed after the transaction.",
      ],
    };
  }
  return { ...plan.base, status: "applied", applied, skills };
}

function applyManagementPlan(
  input: ManageAgentSkillsInput,
  context: ResolvedManagementContext,
  plan: PreparedManagementPlan,
): ManageAgentSkillsResult {
  try {
    const applied = applyPlan(
      input,
      context.targetRoot,
      context.sourceRoot,
      plan.manifest,
      plan.manifestRaw,
      plan.entries,
      context,
    );
    const { manifest: confirmedManifest } = readSkillManifest(
      context.targetRoot,
      input.host,
      input.scope,
    );
    const confirmedEntries = buildPlan(
      { ...input, action: "status", dry_run: true },
      context.targetRoot,
      plan.catalog,
      confirmedManifest,
    );
    return confirmedManagementResult(input, plan, applied, confirmedEntries);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...plan.base,
      status: "failed",
      applied: [],
      warnings: [...plan.base.warnings, message],
    };
  }
}

export function manageAgentSkills(
  input: ManageAgentSkillsInput,
  options: ManageAgentSkillsOptions = {},
): ManageAgentSkillsResult {
  const selected = selectedSkillNames(input);
  const context = resolveManagementContext(input, options);
  const pending = resolvePendingTransactions(input, context);
  if (pending.result) return pending.result;
  const plan = prepareManagementPlan(input, context, selected, pending.warnings);
  const planned = plannedManagementResult(input, context, plan);
  return planned ?? applyManagementPlan(input, context, plan);
}
