import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { TdDocsLookupRequest, TdDocsOutput } from "../../knowledge/tdDocsTypes.js";

const HELP_ROOT = "docs/td-help";
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_IDENTITY = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const MAX_ROUNDTRIP_TYPES = 2_000;
const MAX_MANIFEST_BYTES = 1_048_576;

export const safeHelpIdentitySchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(SAFE_IDENTITY, "Documentation identity must be a class/operator identity, not a path.");

export const componentHelpSnapshotSchema = z
  .object({
    python_apis: z.array(safeHelpIdentitySchema).max(32).default([]),
    max_operator_types: z.number().int().min(1).max(64).default(32),
    max_sections_per_page: z.number().int().min(1).max(4).default(2),
    max_chars_per_section: z.number().int().min(500).max(6_000).default(3_000),
    max_total_bytes: z.number().int().min(32_768).max(1_048_576).default(262_144),
    quarantine_port: z
      .number()
      .int()
      .min(1)
      .max(65_535)
      .refine((port) => port !== 9_980, "The artist bridge port 9980 is forbidden."),
  })
  .strict();

export type ComponentHelpSnapshotOptions = z.infer<typeof componentHelpSnapshotSchema>;
export type ComponentHelpSnapshotInput = z.input<typeof componentHelpSnapshotSchema>;

export const artifactRoundtripReportSchema = z
  .object({
    artifact_sha256: z.string().regex(SHA256),
    td_build: z.union([z.string().trim().min(1).max(64), z.number().int().nonnegative()]),
    operator_type_counts: z.record(safeHelpIdentitySchema, z.number().int().min(1).max(2_000)),
    contract_verdict: z.enum(["PASS", "FAIL", "UNVERIFIED"]),
  })
  .strict()
  .superRefine((value, context) => {
    if (Object.keys(value.operator_type_counts).length > MAX_ROUNDTRIP_TYPES) {
      context.addIssue({
        code: "custom",
        path: ["operator_type_counts"],
        message: `Roundtrip operator inventory exceeds ${MAX_ROUNDTRIP_TYPES} entries.`,
      });
    }
  });

export type ArtifactRoundtripReport = z.infer<typeof artifactRoundtripReportSchema>;

export type ComponentHelpDocsResolver = (request: TdDocsLookupRequest) => Promise<TdDocsOutput>;

export interface ComponentHelpSnapshotHooks {
  beforeWriteFile?(relativePath: string): void;
  afterStageWritten?(stagePath: string): void;
  beforeManifestPromote?(manifestPath: string): void;
  afterManifestPromoted?(manifestPath: string): void;
}

export interface ComponentHelpSnapshotDependencies {
  resolveDocs: ComponentHelpDocsResolver;
  verifyArtifactRoundtrip(request: {
    quarantine_port: number;
    expected: ArtifactRoundtripReport;
  }): Promise<unknown>;
  hooks?: ComponentHelpSnapshotHooks;
}

export interface AttachComponentHelpSnapshotInput {
  package_dir: string;
  manifest_path: string;
  help_snapshot: ComponentHelpSnapshotInput;
  artifact_roundtrip_report: unknown;
}

type HelpKind = "operator" | "python";
type HelpEntryStatus = "available" | "unavailable" | "truncated";
type HelpEntryReason =
  | "filename_collision"
  | "operator_type_cap"
  | "byte_cap"
  | "installed_docs_error"
  | "installed_docs_unavailable"
  | "installed_page_missing"
  | "preferred_section_missing"
  | "installed_source_required"
  | "installed_build_unknown"
  | "installed_build_mismatch"
  | "empty_section";

interface HelpIndexSection {
  id: string;
  title: string;
  chars: number;
  truncated: boolean;
}

interface HelpIndexEntry {
  identity: string;
  kind: HelpKind;
  count?: number;
  status: HelpEntryStatus;
  reason?: HelpEntryReason;
  path?: string;
  bytes?: number;
  sha256?: string;
  installed_corpus_build?: string;
  sections?: HelpIndexSection[];
}

interface SnapshotIndex {
  schema_version: 1;
  status: "PASS" | "UNVERIFIED";
  artifact: {
    sha256: string;
    td_build: string;
    contract_verdict: "PASS" | "FAIL" | "UNVERIFIED";
  };
  limits: {
    max_operator_types: number;
    max_sections_per_page: number;
    max_chars_per_section: number;
    max_total_bytes: number;
  };
  summary: {
    total: number;
    available: number;
    unavailable: number;
    truncated: number;
  };
  reasons: string[];
  entries: HelpIndexEntry[];
}

interface SnapshotFile {
  path: string;
  content: string;
  bytes: number;
  sha256: string;
}

interface CandidatePage {
  entry: HelpIndexEntry;
  file: SnapshotFile;
  sections: HelpIndexSection[];
  installedBuild: string;
}

interface ResolvedHelpSection {
  descriptor: HelpIndexSection;
  content: string;
  installedBuild: string;
  pageId: string;
}

interface SnapshotBundle {
  index: SnapshotIndex;
  files: SnapshotFile[];
  totalBytes: number;
}

export interface ComponentHelpSnapshotResult {
  status: "PASS" | "UNVERIFIED";
  root_path: string;
  manifest_path: string;
  index_path: string;
  readme_path: string;
  artifact_sha256: string;
  td_build: string;
  post_attach_roundtrip_verified: true;
  total_bytes: number;
  counts: SnapshotIndex["summary"];
  files: Array<{ path: string; bytes: number; sha256: string }>;
}

export class ComponentHelpSnapshotError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ComponentHelpSnapshotError";
    this.code = code;
  }
}

const docsOutputSchema = z
  .object({
    status: z.enum(["found", "not_found", "section_not_found", "source_unavailable"]),
    page: z
      .object({
        id: z.string().max(160),
        title: z.string().max(512),
        kind: z.enum(["operator", "python", "concept"]),
      })
      .passthrough()
      .optional(),
    content: z.string().optional(),
    content_truncated: z.boolean(),
    selected_section: z
      .object({
        id: z.string().max(160),
        title: z.string().max(512),
        level: z.number().int().min(1).max(6),
      })
      .passthrough()
      .optional(),
    provenance: z
      .object({
        source: z.enum(["installed-offline", "embedded", "web"]).optional(),
        installed_corpus_build: z.string().max(64).optional(),
        sources_attempted: z.array(z.enum(["installed-offline", "embedded", "web"])).max(3),
      })
      .passthrough(),
  })
  .passthrough();

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareEntries(left: HelpIndexEntry, right: HelpIndexEntry): number {
  return compareText(left.identity, right.identity) || compareText(left.kind, right.kind);
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function asSnapshotFile(path: string, content: string): SnapshotFile {
  return { path, content, bytes: utf8Bytes(content), sha256: sha256(content) };
}

export function normalizeHelpIdentity(identity: string): string {
  const normalized = identity
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96)
    .replace(/-+$/g, "");
  if (!normalized) throw new ComponentHelpSnapshotError("invalid_identity", "Invalid help id.");
  return normalized;
}

function normalizedBuild(value: string | number): string {
  return String(value).trim();
}

function preferredSections(kind: HelpKind, maximum: number): string[] {
  const ordered =
    kind === "operator" ? ["Summary", "Parameters_-_Common_Page"] : ["Members", "Methods"];
  return ordered.slice(0, maximum);
}

function unavailableReason(status: z.infer<typeof docsOutputSchema>["status"]): HelpEntryReason {
  if (status === "source_unavailable") return "installed_docs_unavailable";
  if (status === "section_not_found") return "preferred_section_missing";
  return "installed_page_missing";
}

function sectionMatches(
  selected: z.infer<typeof docsOutputSchema>["selected_section"],
  wanted: string,
): boolean {
  if (!selected) return false;
  const key = wanted.toLowerCase();
  return selected.id.toLowerCase() === key || selected.title.trim().toLowerCase() === key;
}

function pagePath(kind: HelpKind, identity: string): string {
  return `${HELP_ROOT}/${kind}/${normalizeHelpIdentity(identity)}.md`;
}

function pageContent(
  entry: HelpIndexEntry,
  artifactBuild: string,
  sections: Array<{ descriptor: HelpIndexSection; content: string }>,
): string {
  const header = [
    `# ${entry.identity}`,
    "",
    `- Kind: ${entry.kind}`,
    `- TouchDesigner build: ${artifactBuild}`,
    "- Source: installed-offline",
  ];
  const bodies = sections.flatMap(({ descriptor, content }) => [
    "",
    `## ${descriptor.title}`,
    "",
    content,
  ]);
  return `${[...header, ...bodies].join("\n").trimEnd()}\n`;
}

function rejectEntry(entry: HelpIndexEntry, reason: HelpEntryReason): undefined {
  entry.status = "unavailable";
  entry.reason = reason;
  return undefined;
}

async function resolveDocsOutput(
  request: TdDocsLookupRequest,
  entry: HelpIndexEntry,
  resolver: ComponentHelpDocsResolver,
): Promise<z.infer<typeof docsOutputSchema> | undefined> {
  try {
    return docsOutputSchema.parse(await resolver(request));
  } catch {
    return rejectEntry(entry, "installed_docs_error");
  }
}

function installedDocsRejectionReason(
  output: z.infer<typeof docsOutputSchema>,
  artifactBuild: string,
  entry: HelpIndexEntry,
  wantedSection: string,
): HelpEntryReason | undefined {
  if (output.status !== "found") return unavailableReason(output.status);
  if (
    output.provenance.source !== "installed-offline" ||
    output.provenance.sources_attempted.some((source) => source !== "installed-offline")
  ) {
    return "installed_source_required";
  }
  const corpusBuild = output.provenance.installed_corpus_build?.trim();
  if (!corpusBuild) return "installed_build_unknown";
  if (corpusBuild !== artifactBuild) return "installed_build_mismatch";
  if (!output.page || output.page.kind !== entry.kind) return "preferred_section_missing";
  if (!sectionMatches(output.selected_section, wantedSection)) return "preferred_section_missing";
  return undefined;
}

async function resolveHelpSection(
  entry: HelpIndexEntry,
  options: ComponentHelpSnapshotOptions,
  artifactBuild: string,
  resolver: ComponentHelpDocsResolver,
  section: string,
): Promise<ResolvedHelpSection | undefined> {
  const request: TdDocsLookupRequest = {
    query: entry.identity,
    kind: entry.kind,
    section,
    source: "installed",
    web_fallback: false,
    max_chars: options.max_chars_per_section,
  };
  const output = await resolveDocsOutput(request, entry, resolver);
  if (!output) return undefined;
  const reason = installedDocsRejectionReason(output, artifactBuild, entry, section);
  if (reason) return rejectEntry(entry, reason);
  const rawContent = output.content?.trim() ?? "";
  if (!rawContent) return rejectEntry(entry, "empty_section");

  const content = rawContent.slice(0, options.max_chars_per_section);
  const selectedSection = output.selected_section;
  const page = output.page;
  const installedBuild = output.provenance.installed_corpus_build?.trim();
  if (!selectedSection || !page || !installedBuild) {
    return rejectEntry(entry, "preferred_section_missing");
  }
  return {
    descriptor: {
      id: selectedSection.id,
      title: selectedSection.title,
      chars: content.length,
      truncated: output.content_truncated || rawContent.length > content.length,
    },
    content,
    installedBuild,
    pageId: page.id,
  };
}

async function resolveCandidate(
  entry: HelpIndexEntry,
  options: ComponentHelpSnapshotOptions,
  artifactBuild: string,
  resolver: ComponentHelpDocsResolver,
): Promise<CandidatePage | undefined> {
  const sectionResults: Array<{ descriptor: HelpIndexSection; content: string }> = [];
  let installedBuild: string | undefined;
  let pageId: string | undefined;
  for (const section of preferredSections(entry.kind, options.max_sections_per_page)) {
    const resolved = await resolveHelpSection(entry, options, artifactBuild, resolver, section);
    if (!resolved) return undefined;
    if (pageId !== undefined && pageId !== resolved.pageId) {
      return rejectEntry(entry, "installed_page_missing");
    }
    pageId = resolved.pageId;
    installedBuild = resolved.installedBuild;
    sectionResults.push({ descriptor: resolved.descriptor, content: resolved.content });
  }
  if (!installedBuild || sectionResults.length === 0) {
    entry.status = "unavailable";
    entry.reason = "preferred_section_missing";
    return undefined;
  }
  const path = pagePath(entry.kind, entry.identity);
  const file = asSnapshotFile(path, pageContent(entry, artifactBuild, sectionResults));
  return {
    entry,
    file,
    sections: sectionResults.map((result) => result.descriptor),
    installedBuild,
  };
}

function entrySummary(entries: HelpIndexEntry[]): SnapshotIndex["summary"] {
  return {
    total: entries.length,
    available: entries.filter((entry) => entry.status === "available").length,
    unavailable: entries.filter((entry) => entry.status === "unavailable").length,
    truncated: entries.filter((entry) => entry.status === "truncated").length,
  };
}

function snapshotStatus(
  entries: HelpIndexEntry[],
  report: ArtifactRoundtripReport,
  reasons: string[],
): "PASS" | "UNVERIFIED" {
  if (report.contract_verdict !== "PASS" || reasons.length > 0) return "UNVERIFIED";
  return entries.every((entry) => entry.status === "available") ? "PASS" : "UNVERIFIED";
}

function makeIndex(
  entries: HelpIndexEntry[],
  report: ArtifactRoundtripReport,
  options: ComponentHelpSnapshotOptions,
  reasons: string[],
): SnapshotIndex {
  return {
    schema_version: 1,
    status: snapshotStatus(entries, report, reasons),
    artifact: {
      sha256: report.artifact_sha256,
      td_build: normalizedBuild(report.td_build),
      contract_verdict: report.contract_verdict,
    },
    limits: {
      max_operator_types: options.max_operator_types,
      max_sections_per_page: options.max_sections_per_page,
      max_chars_per_section: options.max_chars_per_section,
      max_total_bytes: options.max_total_bytes,
    },
    summary: entrySummary(entries),
    reasons: [...reasons].sort(compareText),
    entries,
  };
}

function renderIndex(index: SnapshotIndex): string {
  return `${JSON.stringify(index, null, 2)}\n`;
}

function renderReadme(index: SnapshotIndex): string {
  const lines = [
    "# TouchDesigner help snapshot",
    "",
    `- Status: ${index.status}`,
    `- TouchDesigner build: ${index.artifact.td_build}`,
    `- Artifact SHA-256: ${index.artifact.sha256}`,
    `- Exact pages: ${index.summary.available}/${index.summary.total}`,
    "",
    "## Pages",
    "",
  ];
  if (index.entries.length === 0) lines.push("No documentation identities were available.");
  for (const entry of index.entries) {
    const label = `${entry.kind}: ${entry.identity}`;
    if (entry.status === "available" && entry.path) {
      lines.push(`- [${label}](${entry.path.slice(`${HELP_ROOT}/`.length)})`);
    } else {
      lines.push(`- ${label} — ${entry.status}: ${entry.reason ?? "unverified"}`);
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function identityEntries(
  report: ArtifactRoundtripReport,
  options: ComponentHelpSnapshotOptions,
): HelpIndexEntry[] {
  const operatorTypes = Object.keys(report.operator_type_counts).sort(compareText);
  const selectedOperators = new Set(operatorTypes.slice(0, options.max_operator_types));
  const entries: HelpIndexEntry[] = operatorTypes.map((identity) => ({
    identity,
    kind: "operator",
    count: report.operator_type_counts[identity],
    status: "truncated",
    reason: selectedOperators.has(identity) ? "byte_cap" : "operator_type_cap",
  }));
  const pythonApis = [...new Set(options.python_apis)].sort(compareText);
  entries.push(
    ...pythonApis.map((identity) => ({
      identity,
      kind: "python" as const,
      status: "truncated" as const,
      reason: "byte_cap" as const,
    })),
  );
  return entries.sort(compareEntries);
}

function markFilenameCollisions(entries: HelpIndexEntry[]): void {
  const byPath = new Map<string, HelpIndexEntry[]>();
  for (const entry of entries) {
    if (entry.reason === "operator_type_cap") continue;
    const path = pagePath(entry.kind, entry.identity);
    const group = byPath.get(path) ?? [];
    group.push(entry);
    byPath.set(path, group);
  }
  for (const group of byPath.values()) {
    if (group.length < 2) continue;
    for (const entry of group) {
      entry.status = "unavailable";
      entry.reason = "filename_collision";
    }
  }
}

function setCandidateAvailable(candidate: CandidatePage): void {
  candidate.entry.status = "available";
  delete candidate.entry.reason;
  candidate.entry.path = candidate.file.path;
  candidate.entry.bytes = candidate.file.bytes;
  candidate.entry.sha256 = candidate.file.sha256;
  candidate.entry.installed_corpus_build = candidate.installedBuild;
  candidate.entry.sections = candidate.sections;
}

function setCandidateTruncated(candidate: CandidatePage): void {
  candidate.entry.status = "truncated";
  candidate.entry.reason = "byte_cap";
  delete candidate.entry.path;
  delete candidate.entry.bytes;
  delete candidate.entry.sha256;
  delete candidate.entry.installed_corpus_build;
  delete candidate.entry.sections;
}

function renderedBase(
  entries: HelpIndexEntry[],
  report: ArtifactRoundtripReport,
  options: ComponentHelpSnapshotOptions,
  reasons: string[],
): { index: SnapshotIndex; indexFile: SnapshotFile; readmeFile: SnapshotFile } {
  const index = makeIndex(entries, report, options, reasons);
  return {
    index,
    indexFile: asSnapshotFile(`${HELP_ROOT}/index.json`, renderIndex(index)),
    readmeFile: asSnapshotFile(`${HELP_ROOT}/README.md`, renderReadme(index)),
  };
}

function initialSnapshotReasons(report: ArtifactRoundtripReport): string[] {
  const reasons: string[] = [];
  if (report.contract_verdict !== "PASS") reasons.push("artifact_contract_not_passed");
  if (Object.keys(report.operator_type_counts).length === 0) {
    reasons.push("operator_inventory_empty");
  }
  return reasons;
}

async function resolveCandidates(
  entries: HelpIndexEntry[],
  options: ComponentHelpSnapshotOptions,
  artifactBuild: string,
  resolver: ComponentHelpDocsResolver,
): Promise<CandidatePage[]> {
  const candidates: CandidatePage[] = [];
  for (const entry of entries) {
    if (entry.reason === "operator_type_cap" || entry.reason === "filename_collision") continue;
    const candidate = await resolveCandidate(entry, options, artifactBuild, resolver);
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

function candidateTotalBytes(
  entries: HelpIndexEntry[],
  report: ArtifactRoundtripReport,
  options: ComponentHelpSnapshotOptions,
  reasons: string[],
  included: SnapshotFile[],
  candidate: CandidatePage,
): number {
  const tentative = renderedBase(entries, report, options, reasons);
  return (
    tentative.indexFile.bytes +
    tentative.readmeFile.bytes +
    included.reduce((sum, file) => sum + file.bytes, 0) +
    candidate.file.bytes
  );
}

function selectCandidateFiles(
  entries: HelpIndexEntry[],
  candidates: CandidatePage[],
  report: ArtifactRoundtripReport,
  options: ComponentHelpSnapshotOptions,
  reasons: string[],
): SnapshotFile[] {
  const included: SnapshotFile[] = [];
  let byteCapReached = false;
  for (const candidate of candidates) {
    if (byteCapReached) {
      setCandidateTruncated(candidate);
      continue;
    }
    setCandidateAvailable(candidate);
    const total = candidateTotalBytes(entries, report, options, reasons, included, candidate);
    if (total <= options.max_total_bytes) {
      included.push(candidate.file);
      continue;
    }
    setCandidateTruncated(candidate);
    byteCapReached = true;
  }
  return included;
}

async function buildSnapshotBundle(
  options: ComponentHelpSnapshotOptions,
  report: ArtifactRoundtripReport,
  resolver: ComponentHelpDocsResolver,
): Promise<SnapshotBundle> {
  const entries = identityEntries(report, options);
  markFilenameCollisions(entries);
  const artifactBuild = normalizedBuild(report.td_build);
  const reasons = initialSnapshotReasons(report);
  const candidates = await resolveCandidates(entries, options, artifactBuild, resolver);
  const included = selectCandidateFiles(entries, candidates, report, options, reasons);

  const base = renderedBase(entries, report, options, reasons);
  const files = [base.readmeFile, base.indexFile, ...included].sort((left, right) =>
    compareText(left.path, right.path),
  );
  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  if (totalBytes > options.max_total_bytes) {
    throw new ComponentHelpSnapshotError(
      "snapshot_index_exceeds_byte_cap",
      "Help snapshot metadata exceeds the configured byte cap.",
    );
  }
  return { index: base.index, files, totalBytes };
}

function assertNoSymlinks(path: string): void {
  const info = lstatSync(path);
  if (info.isSymbolicLink()) {
    throw new ComponentHelpSnapshotError(
      "symlink_rejected",
      "Help snapshot paths cannot be symlinks.",
    );
  }
  if (!info.isDirectory()) return;
  for (const entry of readdirSync(path)) assertNoSymlinks(join(path, entry));
}

function resolveInside(root: string, relativePath: string): string {
  const target = resolve(root, ...relativePath.split("/").filter(Boolean));
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new ComponentHelpSnapshotError("path_escape", "Help snapshot path escapes its root.");
  }
  return target;
}

function assertManifestInPackage(packageDir: string, manifestPath: string): void {
  const rel = relative(packageDir, manifestPath);
  if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
    if (manifestPath === packageDir) {
      throw new ComponentHelpSnapshotError("invalid_manifest", "Manifest must be a package file.");
    }
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new ComponentHelpSnapshotError("path_escape", "Manifest must be inside package_dir.");
    }
  }
}

function readManifest(manifestPath: string): { raw: Buffer; value: Record<string, unknown> } {
  const info = lstatSync(manifestPath);
  if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_MANIFEST_BYTES) {
    throw new ComponentHelpSnapshotError(
      "invalid_manifest",
      "Manifest must be a bounded regular file.",
    );
  }
  const raw = readFileSync(manifestPath);
  let value: unknown;
  try {
    value = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new ComponentHelpSnapshotError("invalid_manifest", "Manifest JSON is invalid.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ComponentHelpSnapshotError("invalid_manifest", "Manifest JSON must be an object.");
  }
  const manifest = value as Record<string, unknown>;
  if (
    manifest.docs !== undefined &&
    (!Array.isArray(manifest.docs) || manifest.docs.some((item) => typeof item !== "string"))
  ) {
    throw new ComponentHelpSnapshotError("invalid_manifest", "Manifest docs must be strings.");
  }
  return { raw, value: manifest };
}

function manifestWithSnapshot(
  manifest: Record<string, unknown>,
  files: SnapshotFile[],
): Record<string, unknown> {
  const prior = (manifest.docs as string[] | undefined) ?? [];
  const unowned = prior.filter((path) => !path.replace(/\\/g, "/").startsWith(`${HELP_ROOT}/`));
  const docs = [...new Set([...unowned, ...files.map((file) => file.path)])].sort(compareText);
  return { ...manifest, docs };
}

function writeBundle(
  stagePath: string,
  bundle: SnapshotBundle,
  hooks?: ComponentHelpSnapshotHooks,
): void {
  for (const file of bundle.files) {
    const relativePath = file.path.slice(`${HELP_ROOT}/`.length);
    hooks?.beforeWriteFile?.(relativePath);
    const target = resolveInside(stagePath, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content, "utf8");
  }
  hooks?.afterStageWritten?.(stagePath);
}

function verifyBundle(stagePath: string, bundle: SnapshotBundle): void {
  assertNoSymlinks(stagePath);
  for (const file of bundle.files) {
    const relativePath = file.path.slice(`${HELP_ROOT}/`.length);
    const target = resolveInside(stagePath, relativePath);
    const info = lstatSync(target);
    if (!info.isFile() || info.size !== file.bytes) {
      throw new ComponentHelpSnapshotError(
        "stage_verification_failed",
        "Staged help file size mismatch.",
      );
    }
    const content = readFileSync(target);
    if (sha256(content) !== file.sha256) {
      throw new ComponentHelpSnapshotError(
        "stage_verification_failed",
        "Staged help file hash mismatch.",
      );
    }
  }
  const parsedIndex = JSON.parse(readFileSync(join(stagePath, "index.json"), "utf8")) as unknown;
  if (JSON.stringify(parsedIndex) !== JSON.stringify(bundle.index)) {
    throw new ComponentHelpSnapshotError(
      "stage_verification_failed",
      "Staged help index mismatch.",
    );
  }
}

function atomicWriteManifest(
  manifestPath: string,
  value: Record<string, unknown>,
  hooks?: ComponentHelpSnapshotHooks,
): void {
  const temporary = join(dirname(manifestPath), `.${basename(manifestPath)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    hooks?.beforeManifestPromote?.(manifestPath);
    renameSync(temporary, manifestPath);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function canonicalTypeCounts(value: Record<string, number>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(value).sort(([left], [right]) => compareText(left, right))),
  );
}

function verifyRoundtripUnchanged(
  before: ArtifactRoundtripReport,
  afterValue: unknown,
): ArtifactRoundtripReport {
  const parsed = artifactRoundtripReportSchema.safeParse(afterValue);
  if (!parsed.success) {
    throw new ComponentHelpSnapshotError(
      "post_attach_roundtrip_invalid",
      "Post-attach roundtrip report is invalid.",
    );
  }
  const after = parsed.data;
  if (
    after.artifact_sha256 !== before.artifact_sha256 ||
    normalizedBuild(after.td_build) !== normalizedBuild(before.td_build) ||
    after.contract_verdict !== before.contract_verdict ||
    canonicalTypeCounts(after.operator_type_counts) !==
      canonicalTypeCounts(before.operator_type_counts)
  ) {
    throw new ComponentHelpSnapshotError(
      "post_attach_roundtrip_changed",
      "Post-attach roundtrip no longer matches the staged artifact.",
    );
  }
  return after;
}

function restoreJournal(
  finalRoot: string,
  backupTree: string,
  manifestPath: string,
  manifestBackup: string,
): void {
  rmSync(finalRoot, { recursive: true, force: true });
  if (existsSync(backupTree)) renameSync(backupTree, finalRoot);
  const originalManifest = readFileSync(manifestBackup);
  const temporary = join(
    dirname(manifestPath),
    `.${basename(manifestPath)}.restore.${randomUUID()}`,
  );
  try {
    writeFileSync(temporary, originalManifest);
    renameSync(temporary, manifestPath);
  } finally {
    rmSync(temporary, { force: true });
  }
}

interface AttachmentTarget {
  packageDir: string;
  manifestPath: string;
  originalManifest: { raw: Buffer; value: Record<string, unknown> };
  docsParent: string;
  finalRoot: string;
}

interface AttachmentJournal {
  stagePath: string;
  journalPath: string;
  backupTree: string;
  manifestBackup: string;
}

function prepareAttachmentTarget(input: AttachComponentHelpSnapshotInput): AttachmentTarget {
  const packageDir = resolve(input.package_dir);
  const manifestPath = resolve(input.manifest_path);
  if (!existsSync(packageDir) || !statSync(packageDir).isDirectory()) {
    throw new ComponentHelpSnapshotError("package_not_found", "Package directory was not found.");
  }
  assertNoSymlinks(packageDir);
  assertManifestInPackage(packageDir, manifestPath);
  const originalManifest = readManifest(manifestPath);
  const docsParent = join(packageDir, "docs");
  const finalRoot = join(docsParent, "td-help");
  return { packageDir, manifestPath, originalManifest, docsParent, finalRoot };
}

function prepareAttachmentDestination(target: AttachmentTarget): void {
  if (existsSync(target.docsParent)) assertNoSymlinks(target.docsParent);
  else mkdirSync(target.docsParent, { recursive: true });
  if (existsSync(target.finalRoot)) assertNoSymlinks(target.finalRoot);
}

function createAttachmentJournal(target: AttachmentTarget): AttachmentJournal {
  const stagePath = mkdtempSync(join(target.docsParent, ".td-help.stage-"));
  const journalPath = mkdtempSync(join(target.docsParent, ".td-help.journal-"));
  const backupTree = join(journalPath, "td-help");
  const manifestBackup = join(journalPath, "manifest.before");
  writeFileSync(manifestBackup, target.originalManifest.raw);
  return { stagePath, journalPath, backupTree, manifestBackup };
}

function snapshotResult(
  target: AttachmentTarget,
  bundle: SnapshotBundle,
  report: ArtifactRoundtripReport,
): ComponentHelpSnapshotResult {
  return {
    status: bundle.index.status,
    root_path: target.finalRoot,
    manifest_path: target.manifestPath,
    index_path: join(target.finalRoot, "index.json"),
    readme_path: join(target.finalRoot, "README.md"),
    artifact_sha256: report.artifact_sha256,
    td_build: normalizedBuild(report.td_build),
    post_attach_roundtrip_verified: true,
    total_bytes: bundle.totalBytes,
    counts: bundle.index.summary,
    files: bundle.files.map(({ path, bytes, sha256: digest }) => ({
      path,
      bytes,
      sha256: digest,
    })),
  };
}

function normalizeSnapshotError(error: unknown): ComponentHelpSnapshotError {
  if (error instanceof ComponentHelpSnapshotError) return error;
  return new ComponentHelpSnapshotError(
    "snapshot_failed",
    `Help snapshot failed (${error instanceof Error ? error.name : "unknown"}).`,
  );
}

function rethrowAttachmentError(
  error: unknown,
  journalStarted: boolean,
  target: AttachmentTarget,
  journal: AttachmentJournal,
): never {
  if (journalStarted) {
    try {
      restoreJournal(
        target.finalRoot,
        journal.backupTree,
        target.manifestPath,
        journal.manifestBackup,
      );
    } catch {
      throw new ComponentHelpSnapshotError(
        "rollback_failed",
        "Help snapshot failed and the docs/manifest rollback could not be confirmed.",
      );
    }
  }
  throw normalizeSnapshotError(error);
}

/**
 * Build and atomically attach an exact-build help subtree to one staged package.
 * The resolver is a narrow internal get_td_docs adapter; requests are always
 * installed-only with web fallback disabled. The post-attach roundtrip callback
 * must use the structured quarantine route and never /api/exec.
 */
export async function attachComponentHelpSnapshot(
  input: AttachComponentHelpSnapshotInput,
  dependencies: ComponentHelpSnapshotDependencies,
): Promise<ComponentHelpSnapshotResult> {
  const options = componentHelpSnapshotSchema.parse(input.help_snapshot);
  const report = artifactRoundtripReportSchema.parse(input.artifact_roundtrip_report);
  const target = prepareAttachmentTarget(input);
  const bundle = await buildSnapshotBundle(options, report, dependencies.resolveDocs);
  prepareAttachmentDestination(target);
  const journal = createAttachmentJournal(target);
  let journalStarted = false;
  try {
    writeBundle(journal.stagePath, bundle, dependencies.hooks);
    verifyBundle(journal.stagePath, bundle);
    if (existsSync(target.finalRoot)) renameSync(target.finalRoot, journal.backupTree);
    journalStarted = true;
    renameSync(journal.stagePath, target.finalRoot);
    const nextManifest = manifestWithSnapshot(target.originalManifest.value, bundle.files);
    atomicWriteManifest(target.manifestPath, nextManifest, dependencies.hooks);
    dependencies.hooks?.afterManifestPromoted?.(target.manifestPath);
    verifyRoundtripUnchanged(
      report,
      await dependencies.verifyArtifactRoundtrip({
        quarantine_port: options.quarantine_port,
        expected: report,
      }),
    );
    return snapshotResult(target, bundle, report);
  } catch (error) {
    rethrowAttachmentError(error, journalStarted, target, journal);
  } finally {
    rmSync(journal.stagePath, { recursive: true, force: true });
    rmSync(journal.journalPath, { recursive: true, force: true });
  }
}
