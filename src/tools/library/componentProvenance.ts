import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { z } from "zod";

const SHA256 = /^[0-9a-f]{64}$/;
const GIT_COMMIT = /^[0-9a-f]{7,64}$/;
const OPERATION_ID = /^[A-Za-z0-9_-]{16,128}$/;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_PROVENANCE_BYTES = 64 * 1024;
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024;

export const componentProvenancePolicySchema = z.enum(["record", "require_clean"]);

export const automaticComponentProvenanceOptionsSchema = z
  .object({
    provenance_policy: componentProvenancePolicySchema.default("record"),
    expected_git_commit: z.string().regex(GIT_COMMIT).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.expected_git_commit !== undefined && value.provenance_policy !== "require_clean") {
      ctx.addIssue({
        code: "custom",
        path: ["expected_git_commit"],
        message: "expected_git_commit requires provenance_policy=require_clean.",
      });
    }
  });

export const componentGitSchema = z
  .object({
    available: z.boolean(),
    commit: z.string().regex(GIT_COMMIT).optional(),
    dirty: z.boolean().optional(),
  })
  .strict()
  .superRefine((git, ctx) => {
    if (git.available && (git.commit === undefined || git.dirty === undefined)) {
      ctx.addIssue({
        code: "custom",
        message: "Available git metadata requires commit and dirty.",
      });
    }
    if (!git.available && (git.commit !== undefined || git.dirty !== undefined)) {
      ctx.addIssue({ code: "custom", message: "Unavailable git metadata cannot carry details." });
    }
  });

export const componentProvenanceRecordSchema = z
  .object({
    schema_version: z.literal(2),
    artifact: z
      .object({
        basename: z.string().min(1).max(255),
        sha256: z.string().regex(SHA256),
        size_bytes: z.number().int().min(1).max(MAX_ARTIFACT_BYTES),
      })
      .strict(),
    manifest_sha256: z.string().regex(SHA256),
    source: z
      .object({
        comp_path: z.string().min(1).max(1024).startsWith("/"),
        op_type: z.string().min(1).max(128),
        operator_id: z.string().min(1).max(128),
      })
      .strict(),
    export_mode: z.enum(["as_is", "portable"]),
    toolchain: z
      .object({
        tdmcp_version: z.string().min(1).max(64),
        td_version: z.string().min(1).max(64),
        td_build: z.number().int().nonnegative(),
        project_save_build: z.number().int().nonnegative().optional(),
      })
      .strict(),
    git: componentGitSchema,
    operation_id: z.string().regex(OPERATION_ID),
    created_at: z.string().datetime({ offset: true }),
  })
  .strict();

export type ComponentGit = z.infer<typeof componentGitSchema>;
export type ComponentProvenanceRecord = z.infer<typeof componentProvenanceRecordSchema>;
export type ComponentProvenancePolicy = z.infer<typeof componentProvenancePolicySchema>;

export const componentProvenanceBuildSchema = z
  .object({
    artifact_path: z.string().min(1).max(4096),
    artifact_basename: z
      .string()
      .min(1)
      .max(255)
      .refine((value) => basename(value) === value && extname(value).toLowerCase() === ".tox"),
    manifest: z.unknown(),
    source: componentProvenanceRecordSchema.shape.source,
    export_mode: componentProvenanceRecordSchema.shape.export_mode,
    toolchain: componentProvenanceRecordSchema.shape.toolchain,
    git: componentGitSchema,
    operation_id: componentProvenanceRecordSchema.shape.operation_id,
    created_at: componentProvenanceRecordSchema.shape.created_at,
  })
  .strict();

export interface ComponentProvenanceArtifact {
  record: ComponentProvenanceRecord;
  bytes: Buffer;
  provenance_sha256: string;
  manifest_sha256: string;
}

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

function normalizeJsonNumber(value: number): number {
  if (!Number.isFinite(value)) throw new Error("Canonical JSON rejects non-finite numbers.");
  return value;
}

function normalizeJsonObject(value: object, depth: number): { [key: string]: JsonValue } {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("Canonical JSON accepts plain objects only.");
  }
  const record = value as Record<string, unknown>;
  const normalized: { [key: string]: JsonValue } = {};
  for (const key of Object.keys(record).sort()) {
    if (record[key] === undefined) throw new Error("Canonical JSON rejects undefined values.");
    normalized[key] = normalizeJson(record[key], depth + 1);
  }
  return normalized;
}

function normalizeJson(value: unknown, depth = 0): JsonValue {
  if (depth > 32) throw new Error("Canonical JSON exceeds maximum depth.");
  if (value === null) return value;
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      return normalizeJsonNumber(value);
    case "object":
      return Array.isArray(value)
        ? value.map((item) => normalizeJson(item, depth + 1))
        : normalizeJsonObject(value, depth);
    default:
      throw new Error("Canonical JSON contains an unsupported value.");
  }
}

export function canonicalJsonBytes(value: unknown, maximum = MAX_MANIFEST_BYTES): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(normalizeJson(value))}\n`, "utf8");
  if (bytes.byteLength > maximum) throw new Error("Canonical JSON exceeds byte limit.");
  return bytes;
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path, { highWaterMark: 1024 * 1024 });
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolvePromise);
  });
  return hash.digest("hex");
}

function regularFile(path: string, expectedExtension?: string): { path: string; size: number } {
  const full = resolve(path);
  if (expectedExtension !== undefined && extname(full).toLowerCase() !== expectedExtension) {
    throw new Error(`Artifact must end in ${expectedExtension}.`);
  }
  if (!existsSync(full)) throw new Error("Artifact does not exist.");
  const link = lstatSync(full);
  if (link.isSymbolicLink() || !link.isFile()) throw new Error("Artifact must be a regular file.");
  const size = statSync(full).size;
  if (size < 1 || size > MAX_ARTIFACT_BYTES) throw new Error("Artifact size is outside bounds.");
  return { path: full, size };
}

export async function buildComponentProvenance(
  input: z.input<typeof componentProvenanceBuildSchema>,
): Promise<ComponentProvenanceArtifact> {
  const parsed = componentProvenanceBuildSchema.parse(input);
  const artifact = regularFile(parsed.artifact_path, ".tox");
  const manifestBytes = canonicalJsonBytes(parsed.manifest);
  const manifestSha256 = sha256Bytes(manifestBytes);
  const artifactSha256 = await sha256File(artifact.path);
  const record = componentProvenanceRecordSchema.parse({
    schema_version: 2,
    artifact: {
      basename: parsed.artifact_basename,
      sha256: artifactSha256,
      size_bytes: artifact.size,
    },
    manifest_sha256: manifestSha256,
    source: parsed.source,
    export_mode: parsed.export_mode,
    toolchain: parsed.toolchain,
    git: parsed.git,
    operation_id: parsed.operation_id,
    created_at: parsed.created_at,
  });
  const bytes = canonicalJsonBytes(record, MAX_PROVENANCE_BYTES);
  return {
    record,
    bytes,
    provenance_sha256: sha256Bytes(bytes),
    manifest_sha256: manifestSha256,
  };
}

export interface GitCommandResult {
  status: number | null;
  stdout?: string;
  error?: Error;
}

export type GitRunner = (cwd: string, args: string[]) => GitCommandResult;

const defaultGitRunner: GitRunner = (cwd, args) =>
  spawnSync("git", ["-C", cwd, ...args], {
    timeout: 750,
    encoding: "utf8",
    maxBuffer: 256 * 1024,
    env: { PATH: process.env.PATH ?? "" },
  });

export function captureComponentGit(
  cwd: string,
  runner: GitRunner = defaultGitRunner,
): ComponentGit {
  const head = runner(cwd, ["rev-parse", "HEAD"]);
  const commit = head.status === 0 && !head.error ? (head.stdout ?? "").trim().toLowerCase() : "";
  if (!GIT_COMMIT.test(commit)) return { available: false };
  const status = runner(cwd, ["status", "--porcelain", "--untracked-files=normal"]);
  if (status.status !== 0 || status.error) return { available: false };
  return { available: true, commit, dirty: (status.stdout ?? "").length > 0 };
}

export type ProvenancePolicyDecision =
  | { ok: true; verdict: "PASS"; git: ComponentGit }
  | {
      ok: false;
      verdict: "FAIL";
      code: "provenance_git_unavailable" | "provenance_dirty" | "provenance_source_stale";
      message: string;
      git: ComponentGit;
    };

export function evaluateProvenancePolicy(
  policy: ComponentProvenancePolicy,
  git: ComponentGit,
  expectedGitCommit?: string,
): ProvenancePolicyDecision {
  const parsedPolicy = componentProvenancePolicySchema.parse(policy);
  const parsedGit = componentGitSchema.parse(git);
  if (expectedGitCommit !== undefined && !GIT_COMMIT.test(expectedGitCommit)) {
    return {
      ok: false,
      verdict: "FAIL",
      code: "provenance_source_stale",
      message: "Expected git commit is invalid.",
      git: parsedGit,
    };
  }
  if (parsedPolicy === "record") return { ok: true, verdict: "PASS", git: parsedGit };
  if (!parsedGit.available) {
    return {
      ok: false,
      verdict: "FAIL",
      code: "provenance_git_unavailable",
      message: "Clean provenance requires available git metadata.",
      git: parsedGit,
    };
  }
  if (parsedGit.dirty) {
    return {
      ok: false,
      verdict: "FAIL",
      code: "provenance_dirty",
      message: "Clean provenance refuses a dirty worktree.",
      git: parsedGit,
    };
  }
  if (expectedGitCommit !== undefined && parsedGit.commit !== expectedGitCommit.toLowerCase()) {
    return {
      ok: false,
      verdict: "FAIL",
      code: "provenance_source_stale",
      message: "Git HEAD does not match the expected commit.",
      git: parsedGit,
    };
  }
  return { ok: true, verdict: "PASS", git: parsedGit };
}

export type PairPromotionPhase =
  | "prepared"
  | "backed_up_tox"
  | "backed_up_provenance"
  | "promoted_tox"
  | "promoted_provenance"
  | "verified";

export interface PairPromotionHooks {
  onPhase?: (phase: PairPromotionPhase) => void | Promise<void>;
}

export interface PairPromotionInput {
  temp_tox_path: string;
  final_tox_path: string;
  provenance_bytes: Uint8Array;
  operation_id: string;
  hooks?: PairPromotionHooks;
}

export interface PairPromotionResult {
  artifact_path: string;
  provenance_path: string;
  artifact_sha256: string;
  provenance_sha256: string;
  deduplicated: boolean;
  journal_removed: boolean;
}

interface PromotionPaths {
  tempTox: string;
  finalTox: string;
  finalProvenance: string;
  tempProvenance: string;
  backupTox: string;
  backupProvenance: string;
  journal: string;
}

interface PreviousPair {
  tox: string | null;
  provenance: string | null;
}

interface PromotionState {
  backedTox: boolean;
  backedProvenance: boolean;
  promotedTox: boolean;
  promotedProvenance: boolean;
}

function safeStem(path: string): string {
  return (
    basename(path)
      .replace(/[^A-Za-z0-9._-]+/g, "_")
      .slice(0, 160) || "component.tox"
  );
}

function pairPaths(input: PairPromotionInput): PromotionPaths {
  if (!OPERATION_ID.test(input.operation_id)) throw new Error("Invalid provenance operation id.");
  const finalTox = resolve(input.final_tox_path);
  const tempTox = resolve(input.temp_tox_path);
  if (extname(finalTox).toLowerCase() !== ".tox" || dirname(tempTox) !== dirname(finalTox)) {
    throw new Error("TOX pair paths must share one directory and use .tox.");
  }
  const stem = safeStem(finalTox);
  const id = input.operation_id.slice(0, 64);
  return {
    tempTox,
    finalTox,
    finalProvenance: `${finalTox}.provenance.json`,
    tempProvenance: join(dirname(finalTox), `.tdmcp-${stem}-${id}.tmp.provenance.json`),
    backupTox: join(dirname(finalTox), `.tdmcp-${stem}-${id}.bak.tox`),
    backupProvenance: join(dirname(finalTox), `.tdmcp-${stem}-${id}.bak.provenance.json`),
    journal: join(dirname(finalTox), `.tdmcp-${stem}-${id}.journal.json`),
  };
}

function rejectSymlink(path: string): void {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error("Provenance pair paths cannot be symlinks.");
  }
}

async function previousPair(paths: PromotionPaths): Promise<PreviousPair> {
  return {
    tox: existsSync(paths.finalTox) ? await sha256File(paths.finalTox) : null,
    provenance: existsSync(paths.finalProvenance) ? await sha256File(paths.finalProvenance) : null,
  };
}

function journalBytes(
  paths: PromotionPaths,
  operationId: string,
  phase: PairPromotionPhase,
  previous: PreviousPair,
): Buffer {
  return canonicalJsonBytes(
    {
      schema_version: 1,
      operation_id: operationId,
      phase,
      artifact: basename(paths.finalTox),
      provenance: basename(paths.finalProvenance),
      had_artifact: previous.tox !== null,
      had_provenance: previous.provenance !== null,
    },
    4096,
  );
}

function writeJournal(
  paths: PromotionPaths,
  operationId: string,
  phase: PairPromotionPhase,
  previous: PreviousPair,
): void {
  const incoming = `${paths.journal}.write`;
  rmSync(incoming, { force: true });
  writeFileSync(incoming, journalBytes(paths, operationId, phase, previous), { flag: "wx" });
  renameSync(incoming, paths.journal);
}

async function phase(
  paths: PromotionPaths,
  input: PairPromotionInput,
  previous: PreviousPair,
  name: PairPromotionPhase,
): Promise<void> {
  writeJournal(paths, input.operation_id, name, previous);
  await input.hooks?.onPhase?.(name);
}

function cleanupTransactionFiles(paths: PromotionPaths): void {
  for (const path of [
    paths.tempProvenance,
    paths.backupTox,
    paths.backupProvenance,
    paths.journal,
    `${paths.journal}.write`,
  ]) {
    rmSync(path, { force: true });
  }
}

function readStaleJournal(paths: PromotionPaths): {
  hadArtifact: boolean | undefined;
  hadProvenance: boolean | undefined;
} {
  let hadArtifact: boolean | undefined;
  let hadProvenance: boolean | undefined;
  try {
    const journal = JSON.parse(readFileSync(paths.journal, "utf8")) as Record<string, unknown>;
    hadArtifact = typeof journal.had_artifact === "boolean" ? journal.had_artifact : undefined;
    hadProvenance =
      typeof journal.had_provenance === "boolean" ? journal.had_provenance : undefined;
  } catch {
    throw new Error("Existing provenance journal is malformed; recovery refused.");
  }
  return { hadArtifact, hadProvenance };
}

function restoreStaleFile(backup: string, final: string, hadPrevious: boolean | undefined): void {
  if (existsSync(backup)) {
    rejectSymlink(backup);
    rmSync(final, { force: true });
    renameSync(backup, final);
    return;
  }
  if (hadPrevious === false) rmSync(final, { force: true });
}

function hasStaleTransaction(paths: PromotionPaths): boolean {
  return (
    existsSync(paths.journal) || existsSync(paths.backupTox) || existsSync(paths.backupProvenance)
  );
}

function recoverStaleTransaction(paths: PromotionPaths): void {
  if (!hasStaleTransaction(paths)) return;
  const previous = existsSync(paths.journal)
    ? readStaleJournal(paths)
    : { hadArtifact: undefined, hadProvenance: undefined };
  restoreStaleFile(paths.backupTox, paths.finalTox, previous.hadArtifact);
  restoreStaleFile(paths.backupProvenance, paths.finalProvenance, previous.hadProvenance);
  rmSync(paths.tempProvenance, { force: true });
  rmSync(paths.journal, { force: true });
  rmSync(`${paths.journal}.write`, { force: true });
}

function assertTransactionPathsClear(paths: PromotionPaths): void {
  const stale = [
    paths.tempProvenance,
    paths.backupTox,
    paths.backupProvenance,
    paths.journal,
    `${paths.journal}.write`,
  ].filter(existsSync);
  if (stale.length > 0) throw new Error("Provenance transaction paths are not clean.");
}

async function finalPairMatches(
  paths: PromotionPaths,
  artifactHash: string,
  provenanceHash: string,
): Promise<boolean> {
  if (!existsSync(paths.finalTox) || !existsSync(paths.finalProvenance)) return false;
  return (
    (await sha256File(paths.finalTox)) === artifactHash &&
    (await sha256File(paths.finalProvenance)) === provenanceHash
  );
}

function removePromotedFile(path: string, promoted: boolean): void {
  if (promoted) rmSync(path, { force: true });
}

function restoreBackupFile(backup: string, final: string, backed: boolean): void {
  if (backed && existsSync(backup)) renameSync(backup, final);
}

function removeUnexpectedNewFile(
  path: string,
  previousHash: string | null,
  promoted: boolean,
): void {
  if (previousHash === null && promoted) rmSync(path, { force: true });
}

function rollbackPair(paths: PromotionPaths, previous: PreviousPair, state: PromotionState): void {
  removePromotedFile(paths.finalProvenance, state.promotedProvenance);
  removePromotedFile(paths.finalTox, state.promotedTox);
  restoreBackupFile(paths.backupProvenance, paths.finalProvenance, state.backedProvenance);
  restoreBackupFile(paths.backupTox, paths.finalTox, state.backedTox);
  removeUnexpectedNewFile(paths.finalProvenance, previous.provenance, state.promotedProvenance);
  removeUnexpectedNewFile(paths.finalTox, previous.tox, state.promotedTox);
}

async function verifyRollback(paths: PromotionPaths, previous: PreviousPair): Promise<boolean> {
  const toxMatches =
    previous.tox === null
      ? !existsSync(paths.finalTox)
      : existsSync(paths.finalTox) && (await sha256File(paths.finalTox)) === previous.tox;
  const provenanceMatches =
    previous.provenance === null
      ? !existsSync(paths.finalProvenance)
      : existsSync(paths.finalProvenance) &&
        (await sha256File(paths.finalProvenance)) === previous.provenance;
  return toxMatches && provenanceMatches;
}

interface PairHashes {
  artifact: string;
  provenance: string;
}

function validateProvenanceBytes(bytes: Uint8Array): void {
  if (bytes.byteLength < 2 || bytes.byteLength > MAX_PROVENANCE_BYTES) {
    throw new Error("Provenance bytes are outside bounds.");
  }
}

function parsePromotionRecord(paths: PromotionPaths, bytes: Uint8Array): ComponentProvenanceRecord {
  const record = componentProvenanceRecordSchema.parse(
    JSON.parse(Buffer.from(bytes).toString("utf8")),
  );
  if (record.artifact.basename !== basename(paths.finalTox)) {
    throw new Error("Provenance artifact basename does not match the final TOX.");
  }
  return record;
}

function pairResult(
  paths: PromotionPaths,
  hashes: PairHashes,
  deduplicated: boolean,
  journalRemoved: boolean,
): PairPromotionResult {
  return {
    artifact_path: paths.finalTox,
    provenance_path: paths.finalProvenance,
    artifact_sha256: hashes.artifact,
    provenance_sha256: hashes.provenance,
    deduplicated,
    journal_removed: journalRemoved,
  };
}

function deduplicatePair(paths: PromotionPaths, hashes: PairHashes): PairPromotionResult {
  rmSync(paths.tempTox, { force: true });
  cleanupTransactionFiles(paths);
  return pairResult(paths, hashes, true, true);
}

async function assertTemporaryPairMatches(
  paths: PromotionPaths,
  record: ComponentProvenanceRecord,
  artifactHash: string,
): Promise<void> {
  const temp = regularFile(paths.tempTox, ".tox");
  if (temp.size !== record.artifact.size_bytes || (await sha256File(temp.path)) !== artifactHash) {
    throw new Error("Temporary TOX does not match its provenance record.");
  }
}

function initialPromotionState(): PromotionState {
  return {
    backedTox: false,
    backedProvenance: false,
    promotedTox: false,
    promotedProvenance: false,
  };
}

async function backupPreviousPair(
  paths: PromotionPaths,
  input: PairPromotionInput,
  previous: PreviousPair,
  state: PromotionState,
): Promise<void> {
  if (previous.tox !== null) {
    renameSync(paths.finalTox, paths.backupTox);
    state.backedTox = true;
  }
  await phase(paths, input, previous, "backed_up_tox");
  if (previous.provenance !== null) {
    renameSync(paths.finalProvenance, paths.backupProvenance);
    state.backedProvenance = true;
  }
  await phase(paths, input, previous, "backed_up_provenance");
}

async function promotePreparedPair(
  paths: PromotionPaths,
  input: PairPromotionInput,
  previous: PreviousPair,
  state: PromotionState,
): Promise<void> {
  renameSync(paths.tempTox, paths.finalTox);
  state.promotedTox = true;
  await phase(paths, input, previous, "promoted_tox");
  renameSync(paths.tempProvenance, paths.finalProvenance);
  state.promotedProvenance = true;
  await phase(paths, input, previous, "promoted_provenance");
}

async function verifyPromotedPair(
  paths: PromotionPaths,
  input: PairPromotionInput,
  previous: PreviousPair,
  hashes: PairHashes,
): Promise<void> {
  if (!(await finalPairMatches(paths, hashes.artifact, hashes.provenance))) {
    throw new Error("Promoted provenance pair failed readback verification.");
  }
  await phase(paths, input, previous, "verified");
}

async function failPairPromotion(
  paths: PromotionPaths,
  previous: PreviousPair,
  state: PromotionState,
): Promise<never> {
  let rollbackVerified = false;
  try {
    rollbackPair(paths, previous, state);
    rollbackVerified = await verifyRollback(paths, previous);
  } finally {
    rmSync(paths.tempTox, { force: true });
    cleanupTransactionFiles(paths);
  }
  if (!rollbackVerified) throw new Error("Provenance pair rollback could not be verified.");
  throw new Error("Provenance pair promotion failed; previous pair restored.");
}

async function executePairPromotion(
  paths: PromotionPaths,
  input: PairPromotionInput,
  previous: PreviousPair,
  state: PromotionState,
  hashes: PairHashes,
): Promise<PairPromotionResult> {
  try {
    assertTransactionPathsClear(paths);
    writeFileSync(paths.tempProvenance, input.provenance_bytes, { flag: "wx" });
    await phase(paths, input, previous, "prepared");
    await backupPreviousPair(paths, input, previous, state);
    await promotePreparedPair(paths, input, previous, state);
    await verifyPromotedPair(paths, input, previous, hashes);
    cleanupTransactionFiles(paths);
    return pairResult(paths, hashes, false, !existsSync(paths.journal));
  } catch {
    return failPairPromotion(paths, previous, state);
  }
}

/**
 * Promote a verified temporary TOX and its v2 provenance sidecar as one
 * recoverable pair. The on-disk journal contains basenames/state only.
 */
export async function promoteComponentPair(
  input: PairPromotionInput,
): Promise<PairPromotionResult> {
  validateProvenanceBytes(input.provenance_bytes);
  const paths = pairPaths(input);
  for (const path of [paths.finalTox, paths.finalProvenance, paths.tempTox]) rejectSymlink(path);
  const record = parsePromotionRecord(paths, input.provenance_bytes);
  const hashes = {
    artifact: record.artifact.sha256,
    provenance: sha256Bytes(input.provenance_bytes),
  };
  if (await finalPairMatches(paths, hashes.artifact, hashes.provenance)) {
    return deduplicatePair(paths, hashes);
  }
  recoverStaleTransaction(paths);
  await assertTemporaryPairMatches(paths, record, hashes.artifact);
  const previous = await previousPair(paths);
  return executePairPromotion(paths, input, previous, initialPromotionState(), hashes);
}
