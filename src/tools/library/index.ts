import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, parse, resolve, sep } from "node:path";
import { z } from "zod";
import { capturePreview } from "../../feedback/previewCapture.js";
import {
  listZipEntryInfo,
  validateArchiveEntries,
  type ZipEntryInfo,
} from "../../packages/archive.js";
import { createPackagePaths } from "../../packages/paths.js";
import { resolvePackageStorage } from "../../packages/scopes.js";
import { type Recipe, RecipeSchema } from "../../recipes/schema.js";
import { TouchDesignerClient } from "../../td-client/touchDesignerClient.js";
import { friendlyTdError } from "../../td-client/types.js";
import { getVersion } from "../../utils/version.js";
import {
  buildGenerateReadmeScript,
  buildReadme,
  type ReadmeReport,
} from "../layer3/generateReadme.js";
import { getTdDocsImpl, getTdDocsOutputSchema } from "../layer3/getTdDocs.js";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult, structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
// Campaign Wave 4 — library/packaging (backlog 2026-05-29):
import { registerChecksumAndVerifyPack } from "./checksumAndVerifyPack.js";
import { registerComponentChangelogTrail } from "./componentChangelogTrail.js";
import {
  type ArtifactRoundtripReport,
  artifactRoundtripReportSchema,
  attachComponentHelpSnapshot,
  type ComponentHelpSnapshotResult,
  componentHelpSnapshotSchema,
} from "./componentHelpSnapshot.js";
import {
  automaticComponentProvenanceOptionsSchema,
  buildComponentProvenance,
  canonicalJsonBytes,
  captureComponentGit,
  componentProvenanceRecordSchema,
  evaluateProvenancePolicy,
  promoteComponentPair,
  sha256Bytes,
} from "./componentProvenance.js";
import { registerCuratedCollectionPack } from "./curatedCollectionPack.js";
import { registerDiffLibraryAssets } from "./diffLibraryAssets.js";
import { registerExportExternalizedTree } from "./exportExternalizedTree.js";
import { registerExportPaletteComponent } from "./exportPaletteComponent.js";
import { registerGenerativeClassicsPack } from "./generativeClassicsPack.js";
import { registerImportRecipeFromUrl } from "./importRecipeFromUrl.js";
import { registerMarketplaceIndexSeed } from "./marketplaceIndexSeed.js";
import { registerProvenanceStamp } from "./provenanceStamp.js";
import {
  runToxRoundtripGate,
  type ToxRoundtripContract,
  type ToxRoundtripGateArgs,
  toxRoundtripGateSchema,
} from "./toxRoundtripGate.js";

const ComponentManifestSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().optional(),
    version: z.string().optional(),
    description: z.string().optional(),
    type: z.string().optional(),
    tox: z.string().optional(),
    assets: z.array(z.string()).default([]),
    docs: z.array(z.string()).default([]),
    recipes: z.array(z.string()).default([]),
  })
  .passthrough();

type ComponentManifest = z.infer<typeof ComponentManifestSchema>;

function manifestCandidates(path: string): string[] {
  const full = resolve(path);
  if (existsSync(full) && statSync(full).isFile()) return [full];
  return [
    join(full, "tdmcp-component.json"),
    join(full, "manifest.json"),
    join(full, "package.json"),
  ];
}

function readManifest(path: string): { path: string; manifest: ComponentManifest } {
  for (const candidate of manifestCandidates(path)) {
    if (!existsSync(candidate)) continue;
    const parsed = ComponentManifestSchema.safeParse(JSON.parse(readFileSync(candidate, "utf8")));
    if (!parsed.success) {
      throw new Error(`Invalid manifest ${candidate}: ${parsed.error.issues.length} issue(s)`);
    }
    return { path: candidate, manifest: parsed.data };
  }
  throw new Error(`No component manifest found at ${path}`);
}

function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function recipeFileName(recipe: Recipe): string {
  return `${recipe.id.replace(/[^a-zA-Z0-9_.-]+/g, "_")}.json`;
}

function safeFileStem(name: string, fallback: string): string {
  return name.replace(/[^a-zA-Z0-9_.-]+/g, "_") || fallback;
}

function safeRelativeSubdir(value: string, field: string): string {
  const normalized = value.trim().replace(/\\/g, "/");
  if (!normalized || normalized === ".") return "";
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error(`${field} must be a relative subdirectory inside the package.`);
  }
  const parts = normalized.split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === "..")) {
    throw new Error(`${field} must not contain "." or ".." path segments.`);
  }
  return parts.join("/");
}

function resolveInside(base: string, rel: string): string {
  const root = resolve(base);
  const normalized = rel.replace(/\\/g, "/");
  if (
    !normalized ||
    normalized.includes("\0") ||
    normalized.startsWith("/") ||
    /^[a-zA-Z]:/.test(normalized)
  ) {
    throw new Error(`Path escapes package directory: ${rel}`);
  }
  const parts = normalized.split("/").filter(Boolean);
  if (parts.some((part) => part === "..")) {
    throw new Error(`Path escapes package directory: ${rel}`);
  }
  const target = resolve(root, ...parts);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error(`Path escapes package directory: ${rel}`);
  }
  return target;
}

function relativeAssetPath(dir: string, fileName: string): string {
  return dir ? `${dir}/${fileName}` : fileName;
}

function manifestRefs(manifest: ComponentManifest): string[] {
  return [
    ...(manifest.assets ?? []),
    ...(manifest.docs ?? []),
    ...(manifest.tox ? [manifest.tox] : []),
  ];
}

const MANIFEST_FILE_NAMES = new Set(["tdmcp-component.json", "manifest.json", "package.json"]);

function assertNotFilesystemRoot(path: string): void {
  const full = resolve(path);
  if (full === parse(full).root) {
    throw new Error(`Package source must not be a filesystem root: ${full}`);
  }
}

function assertNoSymlinksInTree(path: string): void {
  const info = lstatSync(path);
  if (info.isSymbolicLink()) {
    throw new Error(`Package source must not contain symlinks: ${path}`);
  }
  if (!info.isDirectory()) return;
  for (const entry of readdirSync(path)) {
    assertNoSymlinksInTree(join(path, entry));
  }
}

function installPackageSource(source: string): {
  source: string;
  packageName: string;
  kind: "directory" | "zip" | "file";
} {
  const full = resolve(source);
  assertNotFilesystemRoot(full);
  const stats = statSync(full);
  if (stats.isDirectory()) {
    return { source: full, packageName: basename(full), kind: "directory" };
  }
  if (full.toLowerCase().endsWith(".zip")) {
    return { source: full, packageName: basename(full, extname(full)), kind: "zip" };
  }
  if (MANIFEST_FILE_NAMES.has(basename(full))) {
    const packageDir = dirname(full);
    assertNotFilesystemRoot(packageDir);
    return { source: packageDir, packageName: basename(packageDir), kind: "directory" };
  }
  return { source: full, packageName: basename(full, extname(full)), kind: "file" };
}

export function zipExtractCommand(
  zipPath: string,
  destDir: string,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  if (platform === "win32") {
    return {
      command: "powershell",
      args: [
        "-NoProfile",
        "-Command",
        "Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force",
        zipPath,
        destDir,
      ],
    };
  }
  return { command: "unzip", args: ["-o", "-q", zipPath, "-d", destDir] };
}

export function extractZip(
  zipPath: string,
  destDir: string,
  exec: typeof execFileSync = execFileSync,
  listEntries: (zipPath: string) => Array<string | ZipEntryInfo> = listZipEntryInfo,
): void {
  validateArchiveEntries(listEntries(zipPath));
  mkdirSync(destDir, { recursive: true });
  const { command, args } = zipExtractCommand(zipPath, destDir);
  exec(command, args, { stdio: "pipe" });
}

export const browseLibrarySchema = z.object({
  query: z.string().optional(),
  tags: z.array(z.string()).default([]),
  package_dir: z.string().optional(),
  include_recipes: z.boolean().default(true),
  include_packages: z.boolean().default(true),
});
type BrowseLibraryArgs = z.infer<typeof browseLibrarySchema>;

export async function browseLibraryImpl(ctx: ToolContext, args: BrowseLibraryArgs) {
  const query = args.query?.toLowerCase();
  const tags = args.tags.map((t) => t.toLowerCase());
  const recipes = args.include_recipes
    ? ctx.recipes.list().filter((recipe) => {
        const haystack =
          `${recipe.id} ${recipe.name} ${recipe.description} ${recipe.tags.join(" ")}`.toLowerCase();
        if (query && !haystack.includes(query)) return false;
        return tags.every((tag) => recipe.tags.map((t) => t.toLowerCase()).includes(tag));
      })
    : [];
  const packages: Array<{ path: string; id?: string; name?: string; version?: string }> = [];
  const packageDir = args.package_dir ? resolve(args.package_dir) : undefined;
  if (
    args.include_packages &&
    packageDir &&
    existsSync(packageDir) &&
    statSync(packageDir).isDirectory()
  ) {
    for (const entry of readdirSync(packageDir)) {
      const path = join(packageDir, entry);
      if (!statSync(path).isDirectory()) continue;
      try {
        const { manifest } = readManifest(path);
        const haystack =
          `${manifest.id ?? ""} ${manifest.name ?? ""} ${manifest.description ?? ""}`.toLowerCase();
        if (query && !haystack.includes(query)) continue;
        packages.push({ path, id: manifest.id, name: manifest.name, version: manifest.version });
      } catch {
        // Non-package folders are ignored by browse; inspect_component_manifest reports details.
      }
    }
  }
  return structuredResult(`Found ${recipes.length} recipe(s) and ${packages.length} package(s).`, {
    recipes,
    packages,
  });
}

export const inspectComponentManifestSchema = z.object({ path: z.string() });
type InspectComponentManifestArgs = z.infer<typeof inspectComponentManifestSchema>;

export async function inspectComponentManifestImpl(
  _ctx: ToolContext,
  args: InspectComponentManifestArgs,
) {
  try {
    const { path, manifest } = readManifest(args.path);
    const base = dirname(path);
    const missing = manifestRefs(manifest).filter((rel) => {
      try {
        return !existsSync(resolveInside(base, rel));
      } catch {
        return true;
      }
    });
    return structuredResult(`Read component manifest ${path}.`, { path, manifest, missing });
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
}

export const makePortableToxSchema = z.object({
  comp_path: z
    .string()
    .describe("Absolute TouchDesigner COMP path to save, for example /project1/my_component."),
  out_dir: z
    .string()
    .describe("Local output directory that will receive the .tox, manifest, README, and docs."),
  name: z
    .string()
    .optional()
    .describe("Optional filesystem-safe package stem; defaults to the COMP name from comp_path."),
  docs: z
    .array(z.string())
    .default([])
    .describe(
      "Optional local documentation files to copy into out_dir/docs and reference in the manifest.",
    ),
  include_readme: z
    .boolean()
    .default(true)
    .describe(
      "Write a package README.md with node inventory, custom parameters, inputs/outputs, and external file references.",
    ),
  overwrite_policy: z
    .enum(["refuse", "ask"])
    .default("refuse")
    .describe("Refuse an existing .tox or request native Overwrite/Keep consent."),
  confirmation_timeout_ms: z.number().int().min(5_000).max(120_000).default(30_000),
  operation_timeout_ms: z.number().int().min(1_000).max(120_000).default(60_000),
  idempotency_key: z
    .string()
    .min(16)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
  provenance_policy: automaticComponentProvenanceOptionsSchema.shape.provenance_policy,
  expected_git_commit: automaticComponentProvenanceOptionsSchema.shape.expected_git_commit,
  help_snapshot: componentHelpSnapshotSchema
    .optional()
    .describe(
      "Optional exact-build installed OfflineHelp snapshot, verified through a non-9980 quarantine bridge.",
    ),
});
type MakePortableToxArgs = z.input<typeof makePortableToxSchema>;

interface SaveToxReport {
  saved?: string;
  size?: number | null;
  fatal?: string;
}

async function generatePortableReadme(
  ctx: ToolContext,
  compPath: string,
  outDir: string,
  name: string,
) {
  const warnings: string[] = [];
  try {
    const readmeExec = await ctx.client.executePythonScript(
      buildGenerateReadmeScript({ path: compPath }),
      true,
    );
    const readmeReport = parsePythonReport<ReadmeReport>(readmeExec.stdout);
    if (readmeReport.fatal) return { warnings: [`README skipped: ${readmeReport.fatal}`] };
    const path = join(outDir, "README.md");
    writeFileSync(path, buildReadme(readmeReport, { title: name }), "utf8");
    return { path, warnings };
  } catch (err) {
    return { warnings: [`README skipped: ${friendlyTdError(err)}`] };
  }
}

function copyPortableDocs(outDir: string, docs: string[]): string[] {
  return docs.map((doc) => {
    const filename = basename(doc);
    const target = join(outDir, "docs", filename);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(doc, target);
    return `docs/${filename}`;
  });
}

function portableManifest(name: string, toxPath: string, docs: string[]): ComponentManifest {
  return {
    id: name,
    name,
    version: "0.1.0",
    type: "touchdesigner-component",
    tox: basename(toxPath),
    docs,
    assets: [basename(toxPath)],
    recipes: [],
  };
}

function tdBuildNumber(value: unknown): number {
  const matches = String(value ?? "").match(/\d+/g);
  const build = Number(matches?.at(-1));
  if (!Number.isSafeInteger(build) || build < 0) {
    throw new Error("TouchDesigner build metadata is unavailable for provenance.");
  }
  return build;
}

function stagedToxPath(outDir: string, name: string, operationId: string): string {
  return join(outDir, `.tdmcp-${name}-${operationId.slice(0, 64)}.provenance.tmp.tox`);
}

function clearInternalStage(path: string): void {
  if (!existsSync(path)) return;
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error("Portable provenance staging path is unsafe.");
  }
  rmSync(path, { force: true });
}

function priorCreatedAt(provenancePath: string, operationId: string): string | undefined {
  if (!existsSync(provenancePath)) return undefined;
  try {
    const record = componentProvenanceRecordSchema.parse(
      JSON.parse(readFileSync(provenancePath, "utf8")),
    );
    return record.operation_id === operationId ? record.created_at : undefined;
  } catch {
    return undefined;
  }
}

async function existingPortablePair(toxPath: string, manifestPath: string, operationId: string) {
  const provenancePath = `${toxPath}.provenance.json`;
  if (!existsSync(toxPath) || !existsSync(provenancePath) || !existsSync(manifestPath)) {
    return undefined;
  }
  try {
    const record = componentProvenanceRecordSchema.parse(
      JSON.parse(readFileSync(provenancePath, "utf8")),
    );
    const manifest = readManifest(manifestPath).manifest;
    const artifactHash = await sha256File(toxPath);
    const manifestHash = sha256Bytes(canonicalJsonBytes(manifest));
    if (
      record.operation_id !== operationId ||
      record.artifact.sha256 !== artifactHash ||
      record.manifest_sha256 !== manifestHash
    ) {
      return undefined;
    }
    return {
      record,
      artifact_path: toxPath,
      provenance_path: provenancePath,
      artifact_sha256: artifactHash,
      provenance_sha256: await sha256File(provenancePath),
      manifest_sha256: manifestHash,
    };
  } catch {
    return undefined;
  }
}

async function helpRoundtripReport(
  ctx: ToolContext,
  path: string,
  quarantinePort: number,
  expectedHash?: string,
): Promise<ArtifactRoundtripReport> {
  const run = (expectedContract: ToxRoundtripContract) =>
    runToxRoundtripGate(
      {
        path,
        validation_mode: "deep_roundtrip",
        deep: {
          quarantine_host: "127.0.0.1",
          quarantine_port: quarantinePort,
          timeout_ms: 15_000,
          settle_frames: 4,
          max_nodes: 500,
          max_errors: 50,
          max_external_refs: 50,
          expected_contract: expectedContract,
        },
      },
      {
        bridgeToken: ctx.bridgeToken ?? "",
        clientFactory: (baseUrl, token, timeoutMs) =>
          new TouchDesignerClient({ baseUrl, token, timeoutMs, retries: 0 }),
      },
    );
  let data = await run({
    schema_version: 1,
    ...(expectedHash ? { artifact_sha256: expectedHash } : {}),
    max_cook_errors: 0,
  });
  const observed = data.roundtrip.observed;
  if (
    data.roundtrip.verdict !== "PASS" &&
    observed.root_type &&
    observed.node_count !== undefined &&
    observed.type_counts &&
    observed.custom_parameters &&
    observed.connectors &&
    observed.external_references
  ) {
    const external = observed.external_references;
    data = await run({
      schema_version: 1,
      artifact_sha256: data.roundtrip.artifact.sha256,
      root_type: observed.root_type,
      node_count: observed.node_count,
      type_counts: observed.type_counts,
      custom_parameters: observed.custom_parameters,
      connectors: observed.connectors,
      external_references:
        external.total === 0
          ? { policy: "none", count: 0 }
          : {
              policy: "exact",
              count: external.total,
              fingerprints: external.fingerprints,
            },
      max_cook_errors: 0,
    });
  }
  const hash = data.roundtrip.artifact.sha256;
  const build = data.roundtrip.runtime.td_build;
  if (!hash || build === undefined) {
    throw new Error("Quarantine roundtrip did not return artifact/build evidence.");
  }
  return artifactRoundtripReportSchema.parse({
    artifact_sha256: hash,
    td_build: build,
    operator_type_counts: data.roundtrip.observed.type_counts ?? {},
    contract_verdict: data.roundtrip.verdict,
  });
}

async function attachPortableHelpSnapshot(
  ctx: ToolContext,
  outDir: string,
  manifestPath: string,
  toxPath: string,
  helpSnapshot: z.infer<typeof componentHelpSnapshotSchema>,
): Promise<ComponentHelpSnapshotResult> {
  const before = await helpRoundtripReport(ctx, toxPath, helpSnapshot.quarantine_port);
  return attachComponentHelpSnapshot(
    {
      package_dir: outDir,
      manifest_path: manifestPath,
      help_snapshot: helpSnapshot,
      artifact_roundtrip_report: before,
    },
    {
      resolveDocs: async (request) => {
        const result = await getTdDocsImpl(ctx, request);
        if (result.isError || result.structuredContent === undefined) {
          throw new Error("Installed TouchDesigner documentation lookup failed.");
        }
        return getTdDocsOutputSchema.parse(result.structuredContent);
      },
      verifyArtifactRoundtrip: ({ quarantine_port: port, expected }) =>
        helpRoundtripReport(ctx, toxPath, port, expected.artifact_sha256),
    },
  );
}

async function authorizePortableOverwrite(
  ctx: ToolContext,
  args: z.output<typeof makePortableToxSchema>,
  toxPath: string,
): Promise<"Overwrite" | "Keep" | "not_required"> {
  if (!existsSync(toxPath)) return "not_required";
  const info = lstatSync(toxPath);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error("Portable TOX target must be a regular file and cannot be a symlink.");
  }
  if (args.overwrite_policy !== "ask") return "Keep";
  const decision = await ctx.client.requestArtifactOverwriteDecision(
    args.comp_path,
    toxPath,
    args.confirmation_timeout_ms,
  );
  return decision.choice;
}

function portableOverwriteAllowed(decision: "Overwrite" | "Keep" | "not_required"): boolean {
  return decision === "Overwrite" || decision === "not_required";
}

async function refreshExistingComponentProvenance(manifestPath: string, toxPath: string) {
  const provenancePath = `${toxPath}.provenance.json`;
  if (!existsSync(provenancePath)) return undefined;
  const prior = componentProvenanceRecordSchema.parse(
    JSON.parse(readFileSync(provenancePath, "utf8")),
  );
  const tempToxPath = join(
    dirname(toxPath),
    `.tdmcp-${basename(toxPath)}-${prior.operation_id.slice(0, 64)}.docs.tmp.tox`,
  );
  clearInternalStage(tempToxPath);
  try {
    copyFileSync(toxPath, tempToxPath);
    const artifact = await buildComponentProvenance({
      artifact_path: tempToxPath,
      artifact_basename: basename(toxPath),
      manifest: readManifest(manifestPath).manifest,
      source: prior.source,
      export_mode: prior.export_mode,
      toolchain: prior.toolchain,
      git: prior.git,
      operation_id: prior.operation_id,
      created_at: prior.created_at,
    });
    return await promoteComponentPair({
      temp_tox_path: tempToxPath,
      final_tox_path: toxPath,
      provenance_bytes: artifact.bytes,
      operation_id: prior.operation_id,
    });
  } finally {
    clearInternalStage(tempToxPath);
  }
}

function portableProvenancePolicy(ctx: ToolContext, args: z.output<typeof makePortableToxSchema>) {
  const options = automaticComponentProvenanceOptionsSchema.parse({
    provenance_policy: args.provenance_policy,
    expected_git_commit: args.expected_git_commit,
  });
  return evaluateProvenancePolicy(
    options.provenance_policy,
    captureComponentGit(ctx.projectRoot ?? process.cwd()),
    options.expected_git_commit,
  );
}

function portableDeduplicatedReceipt(
  deduplicated: NonNullable<Awaited<ReturnType<typeof existingPortablePair>>>,
  manifestPath: string,
  operationId: string,
  policy: Extract<ReturnType<typeof portableProvenancePolicy>, { ok: true }>,
) {
  const size = statSync(deduplicated.artifact_path).size;
  return {
    status: "succeeded" as const,
    report: { saved: deduplicated.artifact_path, size },
    transaction: {
      operation_id: operationId,
      status: "succeeded" as const,
      verdict: "PASS" as const,
      action_applied: false,
      phases: [],
      deduplicated: true,
      artifact: {
        path: deduplicated.artifact_path,
        size_bytes: size,
        sha256: deduplicated.artifact_sha256,
      },
    },
    manifest_path: manifestPath,
    manifest: readManifest(manifestPath).manifest,
    provenance: { ...deduplicated, deduplicated: true, journal_removed: true },
    provenance_record: deduplicated.record,
    provenance_policy: { verdict: policy.verdict, git: policy.git },
    readme_warnings: [] as string[],
  };
}

async function exportPortableStage(
  ctx: ToolContext,
  args: z.output<typeof makePortableToxSchema>,
  tempToxPath: string,
  operationId: string,
) {
  return ctx.client.exportToxTransaction({
    source_path: args.comp_path,
    target_path: tempToxPath,
    mode: "portable",
    create_folders: true,
    overwrite_policy: "refuse",
    confirmation_timeout_ms: args.confirmation_timeout_ms,
    operation_timeout_ms: args.operation_timeout_ms,
    idempotency_key: operationId,
  });
}

interface PortableSidecarPaths {
  name: string;
  outDir: string;
  toxPath: string;
  tempToxPath: string;
  manifestPath: string;
}

async function finalizePortableSidecars(
  ctx: ToolContext,
  args: z.output<typeof makePortableToxSchema>,
  paths: PortableSidecarPaths,
  operationId: string,
  policy: Extract<ReturnType<typeof portableProvenancePolicy>, { ok: true }>,
  transaction: Awaited<ReturnType<TouchDesignerClient["exportToxTransaction"]>>,
) {
  const readme = args.include_readme
    ? await generatePortableReadme(ctx, args.comp_path, paths.outDir, paths.name)
    : { warnings: [] as string[] };
  const docs = [
    ...(readme.path ? ["README.md"] : []),
    ...copyPortableDocs(paths.outDir, args.docs),
  ];
  writeJson(paths.manifestPath, portableManifest(paths.name, paths.toxPath, docs));
  const helpSnapshot = args.help_snapshot
    ? await attachPortableHelpSnapshot(
        ctx,
        paths.outDir,
        paths.manifestPath,
        paths.tempToxPath,
        args.help_snapshot,
      )
    : undefined;
  const finalManifest = readManifest(paths.manifestPath).manifest;
  const [source, info] = await Promise.all([
    ctx.client.getNode(args.comp_path),
    ctx.client.getInfo({ timeoutMs: 2_000, retryGet: false }),
  ]);
  if (!source.operator_id) {
    throw new Error("TouchDesigner did not return a stable operator identity for provenance.");
  }
  const createdAt =
    priorCreatedAt(`${paths.toxPath}.provenance.json`, operationId) ?? new Date().toISOString();
  const provenanceArtifact = await buildComponentProvenance({
    artifact_path: paths.tempToxPath,
    artifact_basename: basename(paths.toxPath),
    manifest: finalManifest,
    source: {
      comp_path: source.path,
      op_type: source.type || "COMP",
      operator_id: source.operator_id,
    },
    export_mode: "portable",
    toolchain: {
      tdmcp_version: getVersion(),
      td_version: info.td_version ?? String(transaction.artifact?.td_version ?? "unknown"),
      td_build: tdBuildNumber(info.build ?? transaction.artifact?.td_build),
    },
    git: policy.git,
    operation_id: operationId,
    created_at: createdAt,
  });
  const provenance = await promoteComponentPair({
    temp_tox_path: paths.tempToxPath,
    final_tox_path: paths.toxPath,
    provenance_bytes: provenanceArtifact.bytes,
    operation_id: operationId,
  });
  return { finalManifest, helpSnapshot, provenance, provenanceArtifact, readme };
}

async function createPortablePackage(
  ctx: ToolContext,
  args: z.output<typeof makePortableToxSchema>,
  name: string,
  outDir: string,
  toxPath: string,
) {
  const policy = portableProvenancePolicy(ctx, args);
  if (!policy.ok) {
    return {
      status: "failed" as const,
      report: { fatal: policy.message },
      provenance_policy: { verdict: policy.verdict, code: policy.code, git: policy.git },
    };
  }

  mkdirSync(outDir, { recursive: true });
  const operationId = args.idempotency_key ?? randomUUID().replaceAll("-", "_");
  const manifestPath = join(outDir, "tdmcp-component.json");
  const deduplicated = await existingPortablePair(toxPath, manifestPath, operationId);
  if (deduplicated) {
    return portableDeduplicatedReceipt(deduplicated, manifestPath, operationId, policy);
  }

  const decision = await authorizePortableOverwrite(ctx, args, toxPath);
  if (!portableOverwriteAllowed(decision)) {
    return {
      status: "failed" as const,
      report: { fatal: "overwrite was not approved" },
      decision: "Keep" as const,
      provenance_policy: { verdict: policy.verdict, git: policy.git },
    };
  }

  const tempToxPath = stagedToxPath(outDir, name, operationId);
  clearInternalStage(tempToxPath);
  const transaction = await exportPortableStage(ctx, args, tempToxPath, operationId);
  const report: SaveToxReport =
    transaction.status === "succeeded" && transaction.artifact
      ? { saved: toxPath, size: transaction.artifact.size_bytes }
      : { fatal: transaction.error?.message ?? transaction.status };
  if (report.fatal) return { status: "failed" as const, report, transaction };

  try {
    const sidecars = await finalizePortableSidecars(
      ctx,
      args,
      { name, outDir, toxPath, tempToxPath, manifestPath },
      operationId,
      policy,
      transaction,
    );
    return {
      status: "succeeded" as const,
      report,
      transaction,
      manifest_path: manifestPath,
      manifest: sidecars.finalManifest,
      readme_path: sidecars.readme.path,
      readme_warnings: sidecars.readme.warnings,
      provenance: sidecars.provenance,
      provenance_record: sidecars.provenanceArtifact.record,
      provenance_policy: { verdict: policy.verdict, git: policy.git },
      roundtrip_verdict: sidecars.helpSnapshot?.status ?? "UNVERIFIED",
      help_snapshot: sidecars.helpSnapshot,
    };
  } catch (err) {
    clearInternalStage(tempToxPath);
    return {
      status: "partial_failure" as const,
      report,
      transaction,
      sidecar_error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function makePortableToxImpl(ctx: ToolContext, args: MakePortableToxArgs) {
  const parsed = makePortableToxSchema.parse(args);
  const name = safeFileStem(parsed.name ?? basename(parsed.comp_path), "component");
  const outDir = resolve(parsed.out_dir);
  const toxPath = join(outDir, `${name}.tox`);
  return guardTd(
    () => createPortablePackage(ctx, parsed, name, outDir, toxPath),
    (data) => {
      const fatal = "fatal" in data.report ? data.report.fatal : undefined;
      if (fatal) return errorResult(`Portable tox failed: ${fatal}`, data);
      if (data.status === "partial_failure") {
        return errorResult(
          `The .tox export succeeded, but package sidecars failed: ${data.sidecar_error}.`,
          data,
        );
      }
      return jsonResult(`Saved portable .tox package to ${outDir}.`, data);
    },
  );
}

export const exportRecipeBundleSchema = z.object({
  out_file: z.string().describe("Destination path for the portable recipe-bundle JSON file."),
  recipe_ids: z
    .array(z.string())
    .default([])
    .describe("Recipe IDs to export when include_all=false; unknown IDs are listed in missing."),
  include_all: z
    .boolean()
    .default(false)
    .describe(
      "Export the complete local recipe library when true; otherwise export recipe_ids only.",
    ),
});
type ExportRecipeBundleArgs = z.infer<typeof exportRecipeBundleSchema>;

export const exportRecipeBundleOutputSchema = z.object({
  kind: z.literal("tdmcp-recipe-bundle"),
  version: z.number(),
  exported_at: z.string(),
  recipes: z.array(z.unknown()),
  missing: z.array(z.string()),
});

export async function exportRecipeBundleImpl(ctx: ToolContext, args: ExportRecipeBundleArgs) {
  try {
    const recipes = args.include_all
      ? ctx.recipes.all()
      : args.recipe_ids.map((id) => ctx.recipes.get(id)).filter((r): r is Recipe => Boolean(r));
    const missing = args.include_all ? [] : args.recipe_ids.filter((id) => !ctx.recipes.get(id));
    const bundle = {
      kind: "tdmcp-recipe-bundle",
      version: 1,
      exported_at: new Date().toISOString(),
      recipes,
      missing,
    };
    writeJson(args.out_file, bundle);
    return structuredResult(`Exported ${recipes.length} recipe(s) to ${args.out_file}.`, bundle);
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
}

const RECIPE_PUBLISH_MANIFEST = "tdmcp-recipe-publish.json";
const CHECKSUM_MANIFEST = "tdmcp-checksums.json";

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function fileChecksumEntry(
  rootDir: string,
  relPath: string,
): Promise<{
  path: string;
  sha256: string;
  size: number;
}> {
  const abs = join(rootDir, relPath);
  return {
    path: relPath,
    sha256: await sha256File(abs),
    size: statSync(abs).size,
  };
}

export const publishRecipeBundleSchema = z.object({
  out_dir: z
    .string()
    .describe(
      "Local directory where the bundle JSON, publish manifest, and checksum manifest are written.",
    ),
  name: z
    .string()
    .default("recipe-bundle")
    .describe("Filesystem-safe bundle name; becomes <name>.recipes.json after sanitization."),
  version: z
    .string()
    .default("0.1.0")
    .describe("Semantic version recorded in the tdmcp-recipe-publish manifest."),
  recipe_ids: z
    .array(z.string())
    .default([])
    .describe(
      "Recipe ids to include when include_all is false; missing ids are reported in the bundle.",
    ),
  include_all: z
    .boolean()
    .default(false)
    .describe(
      "When true, publish every recipe in the loaded recipe library and ignore recipe_ids.",
    ),
  overwrite: z
    .boolean()
    .default(false)
    .describe("When false, fail if any output artifact already exists; set true to replace them."),
});
type PublishRecipeBundleArgs = z.input<typeof publishRecipeBundleSchema>;

export async function publishRecipeBundleImpl(ctx: ToolContext, args: PublishRecipeBundleArgs) {
  try {
    const outDir = resolve(args.out_dir);
    const name = safeFileStem(args.name ?? "recipe-bundle", "recipe-bundle");
    const bundleRel = `${name}.recipes.json`;
    const bundlePath = join(outDir, bundleRel);
    const publishManifestPath = join(outDir, RECIPE_PUBLISH_MANIFEST);
    const checksumManifestPath = join(outDir, CHECKSUM_MANIFEST);
    const overwrite = args.overwrite ?? false;

    for (const path of [bundlePath, publishManifestPath, checksumManifestPath]) {
      if (existsSync(path) && !overwrite) {
        return errorResult(
          `Publish artifact already exists: ${path}. Pass overwrite:true to replace it.`,
        );
      }
    }

    const recipeIds = args.recipe_ids ?? [];
    const includeAll = args.include_all ?? false;
    const recipes = includeAll
      ? ctx.recipes.all()
      : recipeIds.map((id) => ctx.recipes.get(id)).filter((r): r is Recipe => Boolean(r));
    const missing = includeAll ? [] : recipeIds.filter((id) => !ctx.recipes.get(id));
    const exportedAt = new Date().toISOString();
    const bundle = {
      kind: "tdmcp-recipe-bundle",
      version: 1,
      exported_at: exportedAt,
      recipes,
      missing,
    };

    mkdirSync(outDir, { recursive: true });
    writeJson(bundlePath, bundle);

    const bundleEntry = await fileChecksumEntry(outDir, bundleRel);
    const publishManifest = {
      kind: "tdmcp-recipe-publish",
      schema_version: 1,
      name,
      version: args.version ?? "0.1.0",
      exported_at: exportedAt,
      bundle: bundleRel,
      recipe_count: recipes.length,
      recipes: recipes.map((recipe) => recipe.id),
      missing,
      files: [bundleEntry],
    };
    writeJson(publishManifestPath, publishManifest);

    const checksumManifest = {
      kind: "tdmcp-checksum-manifest",
      version: 1,
      tdmcp_version: getVersion(),
      created_at: new Date().toISOString(),
      root: outDir,
      files: [bundleEntry, await fileChecksumEntry(outDir, RECIPE_PUBLISH_MANIFEST)].sort((a, b) =>
        a.path.localeCompare(b.path),
      ),
    };
    writeJson(checksumManifestPath, checksumManifest);

    return jsonResult(`Published ${recipes.length} recipe(s) to ${outDir}.`, {
      out_dir: outDir,
      bundle_path: bundlePath,
      manifest_path: publishManifestPath,
      checksum_manifest_path: checksumManifestPath,
      manifest: publishManifest,
      checksums: checksumManifest,
    });
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
}

export const importRecipeBundleSchema = z.object({
  bundle_file: z.string(),
  out_dir: z.string(),
  overwrite: z.boolean().default(false),
});
type ImportRecipeBundleArgs = z.infer<typeof importRecipeBundleSchema>;

export async function importRecipeBundleImpl(_ctx: ToolContext, args: ImportRecipeBundleArgs) {
  try {
    const raw = JSON.parse(readFileSync(args.bundle_file, "utf8")) as { recipes?: unknown[] };
    const recipes = z.array(RecipeSchema).parse(raw.recipes ?? []);
    const targets = recipes.map((recipe) => ({
      recipe,
      out: join(args.out_dir, recipeFileName(recipe)),
    }));
    const seenTargets = new Map<string, string>();
    for (const { recipe, out } of targets) {
      const existingRecipeId = seenTargets.get(out);
      if (existingRecipeId) {
        return errorResult(
          `Duplicate recipe target path: ${out} (${existingRecipeId} and ${recipe.id}).`,
        );
      }
      seenTargets.set(out, recipe.id);
    }
    if (!args.overwrite) {
      for (const { out } of targets) {
        if (existsSync(out)) {
          return errorResult(`Recipe already exists: ${out}. Pass overwrite:true to replace it.`);
        }
      }
    }
    const written: string[] = [];
    for (const { recipe, out } of targets) {
      writeJson(out, recipe);
      written.push(out);
    }
    return jsonResult(`Imported ${written.length} recipe(s) into ${args.out_dir}.`, { written });
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
}

export const validateLibraryAssetSchema = toxRoundtripGateSchema;
type ValidateLibraryAssetArgs = ToxRoundtripGateArgs;

async function validateDeepLibraryAsset(ctx: ToolContext, args: ValidateLibraryAssetArgs) {
  const data = await runToxRoundtripGate(args, {
    bridgeToken: ctx.bridgeToken ?? "",
    clientFactory: (baseUrl, token, timeoutMs) =>
      new TouchDesignerClient({ baseUrl, token, timeoutMs, retries: 0 }),
  });
  const cleanup = data.roundtrip.cleanup.verified ? "verified" : "unverified";
  return structuredResult(
    `TOX roundtrip ${data.roundtrip.verdict}: ${data.roundtrip.checks.length} check(s), cleanup ${cleanup}.`,
    data,
  );
}

function manifestAssetIssues(full: string, manifestPath: string): string[] {
  const issues: string[] = [];
  try {
    const found = readManifest(manifestPath);
    const base = dirname(found.path);
    let referenced = false;
    for (const rel of manifestRefs(found.manifest)) {
      try {
        if (resolveInside(base, rel) === full) referenced = true;
      } catch {
        issues.push(`Manifest reference escapes package directory: ${rel}`);
      }
    }
    if (!referenced) issues.push("Asset is not referenced by the manifest.");
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
  }
  return issues;
}

function validateStaticLibraryAsset(args: ValidateLibraryAssetArgs) {
  const full = resolve(args.path);
  const exists = existsSync(full);
  const issues = exists ? [] : [`Missing asset: ${full}`];
  if (args.manifest_path) issues.push(...manifestAssetIssues(full, args.manifest_path));
  const info = exists ? statSync(full) : undefined;
  return structuredResult(
    issues.length ? `${issues.length} asset issue(s).` : "Asset looks valid.",
    {
      path: full,
      exists,
      size: info?.size ?? null,
      extension: extname(full).toLowerCase(),
      issues,
    },
  );
}

export function validateLibraryAssetImpl(ctx: ToolContext, args: ValidateLibraryAssetArgs) {
  return args.validation_mode === "deep_roundtrip"
    ? validateDeepLibraryAsset(ctx, args)
    : Promise.resolve(validateStaticLibraryAsset(args));
}

export const scaffoldRecipeTemplateSchema = z.object({
  out_file: z.string(),
  id: z.string(),
  name: z.string(),
  overwrite: z.boolean().default(false),
});
type ScaffoldRecipeTemplateArgs = z.infer<typeof scaffoldRecipeTemplateSchema>;

export async function scaffoldRecipeTemplateImpl(
  _ctx: ToolContext,
  args: ScaffoldRecipeTemplateArgs,
) {
  try {
    if (existsSync(args.out_file) && !args.overwrite) {
      return errorResult(
        `Recipe template already exists: ${args.out_file}. Pass overwrite:true to replace it.`,
      );
    }
    const recipe = RecipeSchema.parse({
      id: args.id,
      name: args.name,
      description: "Describe what this recipe builds.",
      tags: ["template"],
      difficulty: "beginner",
      nodes: [
        { name: "source", type: "noiseTOP", parameters: {} },
        { name: "out1", type: "nullTOP", parameters: {} },
      ],
      connections: [{ from: "source", to: "out1" }],
      parameters: [],
      controls: [],
      preview_description: "A starter recipe template.",
    });
    writeJson(args.out_file, recipe);
    return jsonResult(`Scaffolded recipe template ${args.out_file}.`, {
      recipe,
      out_file: args.out_file,
    });
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
}

export const attachDocsAsAssetsSchema = z
  .object({
    manifest_path: z.string(),
    docs: z.array(z.string()).default([]),
    asset_dir: z.string().default("docs"),
    help_snapshot: componentHelpSnapshotSchema
      .optional()
      .describe("Attach an exact-build installed OfflineHelp snapshot for the packaged TOX."),
  })
  .superRefine((value, context) => {
    if (value.docs.length === 0 && value.help_snapshot === undefined) {
      context.addIssue({
        code: "custom",
        path: ["docs"],
        message: "Provide at least one doc or help_snapshot.",
      });
    }
  });
type AttachDocsAsAssetsArgs = z.input<typeof attachDocsAsAssetsSchema>;

function copyAttachedDocs(base: string, assetDir: string, docs: string[]): string[] {
  return docs.map((doc) => {
    const rel = relativeAssetPath(assetDir, basename(doc));
    const dest = resolveInside(base, rel);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(doc, dest);
    return rel;
  });
}

async function attachRequestedHelp(
  ctx: ToolContext,
  base: string,
  manifestPath: string,
  manifest: ComponentManifest,
  options: z.infer<typeof componentHelpSnapshotSchema> | undefined,
) {
  if (!options) return undefined;
  if (!manifest.tox) throw new Error("Component manifest has no TOX for help snapshot discovery.");
  return attachPortableHelpSnapshot(
    ctx,
    base,
    manifestPath,
    resolveInside(base, manifest.tox),
    options,
  );
}

async function attachDocsAsAssets(ctx: ToolContext, args: AttachDocsAsAssetsArgs) {
  const parsed = attachDocsAsAssetsSchema.parse(args);
  const { path: manifestPath, manifest } = readManifest(parsed.manifest_path);
  const base = dirname(manifestPath);
  const assetDir = safeRelativeSubdir(parsed.asset_dir, "asset_dir");
  const attached = copyAttachedDocs(base, assetDir, parsed.docs);
  const next = { ...manifest, docs: [...new Set([...(manifest.docs ?? []), ...attached])] };
  writeJson(manifestPath, next);
  const helpSnapshot = await attachRequestedHelp(
    ctx,
    base,
    manifestPath,
    next,
    parsed.help_snapshot,
  );
  const finalManifest = readManifest(manifestPath).manifest;
  const toxPath = finalManifest.tox ? resolveInside(base, finalManifest.tox) : undefined;
  const provenance = toxPath
    ? await refreshExistingComponentProvenance(manifestPath, toxPath)
    : undefined;
  return jsonResult(
    `Attached ${attached.length} doc asset(s)${helpSnapshot ? " and an exact-build TD help snapshot" : ""}.`,
    {
      manifest_path: manifestPath,
      attached,
      help_snapshot: helpSnapshot,
      provenance,
      manifest: finalManifest,
    },
  );
}

export async function attachDocsAsAssetsImpl(ctx: ToolContext, args: AttachDocsAsAssetsArgs) {
  try {
    return await attachDocsAsAssets(ctx, args);
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
}

export const localMarketplaceIndexSchema = z.object({
  package_dir: z.string(),
  out_file: z.string().optional(),
});
type LocalMarketplaceIndexArgs = z.infer<typeof localMarketplaceIndexSchema>;

export async function localMarketplaceIndexImpl(
  _ctx: ToolContext,
  args: LocalMarketplaceIndexArgs,
) {
  try {
    const entries: Array<{
      path: string;
      id?: string;
      name?: string;
      version?: string;
      manifest: string;
    }> = [];
    if (existsSync(args.package_dir)) {
      for (const entry of readdirSync(args.package_dir)) {
        const path = join(args.package_dir, entry);
        if (!statSync(path).isDirectory()) continue;
        try {
          const found = readManifest(path);
          entries.push({
            path,
            id: found.manifest.id,
            name: found.manifest.name,
            version: found.manifest.version,
            manifest: found.path,
          });
        } catch {
          // skip non-package folders
        }
      }
    }
    const index = {
      kind: "tdmcp-local-marketplace-index",
      generated_at: new Date().toISOString(),
      entries,
    };
    const out = args.out_file ?? join(args.package_dir, "index.json");
    writeJson(out, index);
    return jsonResult(`Indexed ${entries.length} local package(s) at ${out}.`, index);
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
}

export const componentLinkHealthSchema = z.object({
  paths: z.array(z.string()).default([]),
  parent_path: z.string().default("/project1"),
});
type ComponentLinkHealthArgs = z.infer<typeof componentLinkHealthSchema>;

interface LinkHealthReport {
  checked: Array<{ path: string; externaltox?: string; exists?: boolean; issue?: string }>;
  fatal?: string;
}

const LINK_HEALTH_SCRIPT = `
import json, base64, os, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"checked": []}
try:
    _paths = _p.get("paths") or []
    if not _paths:
        _parent = op(_p["parent_path"])
        if _parent is None:
            report["fatal"] = "Parent not found: " + _p["parent_path"]
        else:
            _paths = [c.path for c in _parent.children if getattr(c, "isCOMP", False)]
    if not report.get("fatal"):
        for _path in _paths:
            _n = op(_path)
            if _n is None:
                report["checked"].append({"path": _path, "issue": "node not found"})
                continue
            _tox = ""
            try:
                _tox = str(_n.par.externaltox.eval())
            except Exception:
                _tox = ""
            _item = {"path": _path, "externaltox": _tox}
            if _tox:
                _item["exists"] = os.path.exists(_tox)
                if not _item["exists"]:
                    _item["issue"] = "externaltox file missing"
            report["checked"].append(_item)
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export async function componentLinkHealthImpl(ctx: ToolContext, args: ComponentLinkHealthArgs) {
  return guardTd(
    async () => {
      const exec = await ctx.client.executePythonScript(
        buildPayloadScript(LINK_HEALTH_SCRIPT, args),
        true,
      );
      return parsePythonReport<LinkHealthReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) return errorResult(`Component link health failed: ${report.fatal}`, report);
      const issues = report.checked.filter((item) => item.issue).length;
      return jsonResult(
        `Checked ${report.checked.length} component link(s), ${issues} issue(s).`,
        report,
      );
    },
  );
}

export const refreshAssetPreviewsSchema = z.object({
  targets: z
    .array(
      z.object({
        node_path: z
          .string()
          .describe("Live TOP node path to capture through the TouchDesigner bridge."),
        file_path: z
          .string()
          .describe("Local PNG file path to create or overwrite with the captured preview."),
      }),
    )
    .min(1)
    .describe("Preview capture jobs; each target maps one live TOP node to one local PNG file."),
  width: z.coerce
    .number()
    .int()
    .positive()
    .default(640)
    .describe("Preview width in pixels requested from the bridge capture helper."),
  height: z.coerce
    .number()
    .int()
    .positive()
    .default(360)
    .describe("Preview height in pixels requested from the bridge capture helper."),
});
type RefreshAssetPreviewsArgs = z.infer<typeof refreshAssetPreviewsSchema>;

export async function refreshAssetPreviewsImpl(ctx: ToolContext, args: RefreshAssetPreviewsArgs) {
  const written: Array<{ node_path: string; file_path: string; bytes: number }> = [];
  const warnings: string[] = [];
  for (const target of args.targets) {
    try {
      const preview = await capturePreview(ctx.client, target.node_path, args.width, args.height);
      const bytes = Buffer.from(preview.base64, "base64");
      mkdirSync(dirname(target.file_path), { recursive: true });
      writeFileSync(target.file_path, bytes);
      written.push({
        node_path: target.node_path,
        file_path: target.file_path,
        bytes: bytes.length,
      });
    } catch (err) {
      warnings.push(`${target.node_path}: ${friendlyTdError(err)}`);
    }
  }
  const summary = `Refreshed ${written.length}/${args.targets.length} preview asset(s).`;
  const report = {
    written,
    warnings,
  };
  if (written.length === 0) return errorResult(summary, report);
  return jsonResult(summary, report);
}

export const installLibraryPackageSchema = z.object({
  source: z.string().describe("Local package folder, .zip, .tox, or manifest file."),
  dest_dir: z
    .string()
    .optional()
    .describe(
      "Legacy explicit library directory. Omit it to use the selected project/user package scope.",
    ),
  scope: z
    .enum(["user", "project"])
    .default("user")
    .describe("Package ownership scope; project scope requires project_dir."),
  project_dir: z
    .string()
    .optional()
    .describe("Explicit project directory used for <project>/.tdmcp/packages."),
  packages_root: z
    .string()
    .optional()
    .describe("Legacy advanced user-scope package root override."),
  overwrite: z
    .boolean()
    .default(false)
    .describe(
      "When false, fail if the destination package already exists; set true to replace it.",
    ),
});
type InstallLibraryPackageArgs = z.input<typeof installLibraryPackageSchema>;

function libraryInstallStorage(args: InstallLibraryPackageArgs) {
  const scope = args.scope ?? "user";
  if (args.dest_dir) {
    if (scope === "project" || args.project_dir || args.packages_root) {
      throw new Error(
        "dest_dir is a legacy explicit destination and cannot be combined with project_dir, packages_root, or project scope.",
      );
    }
    return {
      destinationRoot: resolve(args.dest_dir),
      storage: { scope: "user" as const, root: resolve(args.dest_dir), source: "legacy-dest" },
    };
  }
  const storage = resolvePackageStorage({
    scope,
    projectDir: args.project_dir,
    rootOverride: args.packages_root,
  });
  return {
    destinationRoot: createPackagePaths({ rootDir: storage.root }).installRoot,
    storage,
  };
}

export async function installLibraryPackageImpl(
  _ctx: ToolContext,
  args: InstallLibraryPackageArgs,
) {
  try {
    const source = resolve(args.source);
    if (!existsSync(source)) return errorResult(`Package source not found: ${source}`);
    const packageSource = installPackageSource(source);
    const { destinationRoot, storage } = libraryInstallStorage(args);
    const dest = resolve(destinationRoot, packageSource.packageName);
    if (existsSync(dest) && !args.overwrite) {
      return errorResult(
        `Destination already exists: ${dest}. Pass overwrite:true to replace/update it.`,
      );
    }
    mkdirSync(dirname(dest), { recursive: true });
    if (packageSource.kind === "directory") {
      assertNoSymlinksInTree(packageSource.source);
      cpSync(packageSource.source, dest, { recursive: true, force: args.overwrite });
    } else if (packageSource.kind === "zip") {
      extractZip(packageSource.source, dest);
    } else {
      mkdirSync(dest, { recursive: true });
      copyFileSync(packageSource.source, join(dest, basename(packageSource.source)));
    }
    return jsonResult(`Installed library package to ${dest}.`, { source, dest, storage });
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
}

export const libraryRegistrars: ToolRegistrar[] = [
  (server, ctx) =>
    server.registerTool(
      "browse_library",
      {
        title: "Browse library",
        description:
          "Browse built-in/vault recipes and optional local component packages. Read-only discovery step before instantiating a recipe (apply_recipe) or installing a package (install_library_package); returns the matching recipes and packages so an agent can pick one by name.",
        inputSchema: browseLibrarySchema.shape,
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
        outputSchema: z.object({ recipes: z.array(z.unknown()), packages: z.array(z.unknown()) })
          .shape,
      },
      (args) => browseLibraryImpl(ctx, args),
    ),
  (server, ctx) =>
    server.registerTool(
      "inspect_component_manifest",
      {
        title: "Inspect component manifest",
        description:
          "Read and validate a tdmcp component/library manifest from a package folder or file. Read-only: use it to check a package's metadata, declared assets, and docs before install_library_package or make_portable_tox; reports validation problems instead of throwing.",
        inputSchema: inspectComponentManifestSchema.shape,
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      },
      (args) => inspectComponentManifestImpl(ctx, args),
    ),
  (server, ctx) =>
    server.registerTool(
      "make_portable_tox",
      {
        title: "Make portable tox",
        description:
          "Save one live TouchDesigner COMP as a portable .tox package on disk, then write a tdmcp-component manifest beside it and optionally copy docs/README files. Use this for packaging a finished component; use bundle_dependencies instead when external media must be collected and relinked. Requires a running bridge and writes/overwrites local files in out_dir; returns the saved .tox path, manifest path, README path, and warnings.",
        inputSchema: makePortableToxSchema.shape,
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      },
      (args) => makePortableToxImpl(ctx, args),
    ),
  (server, ctx) =>
    server.registerTool(
      "export_recipe_bundle",
      {
        title: "Export recipe bundle",
        description:
          "Write a portable JSON recipe bundle to out_file. When include_all=false, recipe_ids selects the entries; " +
          "when include_all=true, the full local library is exported and recipe_ids is ignored. Unknown IDs are " +
          "reported in missing rather than silently substituted. Use import_recipe_bundle to restore the bundle on " +
          "another machine or publish_recipe_bundle when you need checksums/versioned handoff artifacts. This writes " +
          "a local file and returns the bundle kind, version, timestamp, exported recipes, and missing IDs.",
        inputSchema: exportRecipeBundleSchema.shape,
        outputSchema: exportRecipeBundleOutputSchema.shape,
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      },
      (args) => exportRecipeBundleImpl(ctx, args),
    ),
  (server, ctx) =>
    server.registerTool(
      "publish_recipe_bundle",
      {
        title: "Publish recipe bundle",
        description:
          "Write a local, versioned recipe-bundle publish artifact for CI upload or handoff: <name>.recipes.json, tdmcp-recipe-publish.json, and tdmcp-checksums.json. Use recipe_ids for selected recipes or include_all=true for the whole library; overwrite=false protects existing artifacts. This is a filesystem write tool and returns artifact paths, checksum entries, included recipe count, and missing ids.",
        inputSchema: publishRecipeBundleSchema.shape,
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      },
      (args) => publishRecipeBundleImpl(ctx, args),
    ),
  (server, ctx) =>
    server.registerTool(
      "import_recipe_bundle",
      {
        title: "Import recipe bundle",
        description:
          "Import recipes from a portable JSON bundle into a recipe directory. The inverse of export_recipe_bundle: each recipe is validated before it is written, so a malformed bundle fails loudly instead of corrupting the directory. Writes files (destructive).",
        inputSchema: importRecipeBundleSchema.shape,
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      },
      (args) => importRecipeBundleImpl(ctx, args),
    ),
  (server, ctx) =>
    server.registerTool(
      "validate_library_asset",
      {
        title: "Validate library asset",
        description:
          "Check that a local library asset exists and is referenced by an optional manifest. The default static mode preserves the cheap filesystem check. Opt-in deep_roundtrip validates an absolute .tox in an authenticated disposable quarantine bridge on a non-9980 port, using a structured loadTox-only job with bounded polling and verified scratch cleanup; offline evidence is UNVERIFIED, never PASS.",
        inputSchema: validateLibraryAssetSchema.shape,
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      },
      (args) => validateLibraryAssetImpl(ctx, args),
    ),
  (server, ctx) =>
    server.registerTool(
      "scaffold_recipe_template",
      {
        title: "Scaffold recipe template",
        description:
          "Write a minimal but valid recipe JSON template to disk as a starting point for a new recipe. Use it to bootstrap a hand-authored recipe that already passes RecipeSchema; fill in nodes/connections, then instantiate with apply_recipe. Writes a file (destructive).",
        inputSchema: scaffoldRecipeTemplateSchema.shape,
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      },
      (args) => scaffoldRecipeTemplateImpl(ctx, args),
    ),
  (server, ctx) =>
    server.registerTool(
      "attach_docs_as_assets",
      {
        title: "Attach docs as assets",
        description:
          "Copy documentation files into a package and register them in its manifest's docs list. Use after make_portable_tox to bundle a README or usage notes with a component so they travel with it; writes into the package folder (destructive).",
        inputSchema: attachDocsAsAssetsSchema.shape,
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      },
      (args) => attachDocsAsAssetsImpl(ctx, args),
    ),
  (server, ctx) =>
    server.registerTool(
      "local_marketplace_index",
      {
        title: "Local marketplace index",
        description:
          "Scan a local package directory and write an index of installable tdmcp packages. Use it to make a folder of components browsable and installable as a simple local marketplace; the written index is what browse_library and install_library_package consume. Writes a file (destructive).",
        inputSchema: localMarketplaceIndexSchema.shape,
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      },
      (args) => localMarketplaceIndexImpl(ctx, args),
    ),
  (server, ctx) =>
    server.registerTool(
      "component_link_health",
      {
        title: "Component link health",
        description:
          "Probe live COMPs in the running project for externaltox paths and report missing or broken linked component files. Read-only diagnostic: run it when externally-linked .tox components may have moved or gone stale, before relying on them in a build.",
        inputSchema: componentLinkHealthSchema.shape,
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      },
      (args) => componentLinkHealthImpl(ctx, args),
    ),
  (server, ctx) =>
    server.registerTool(
      "refresh_asset_previews",
      {
        title: "Refresh asset previews",
        description:
          "Capture fresh preview PNG assets from one or more live TOP nodes and write each target to its file_path. Use it to regenerate stale thumbnails after a network changes; pass targets as {node_path,file_path} plus optional width/height. Requires a running TouchDesigner bridge, overwrites image files, and returns written previews plus per-target warnings.",
        inputSchema: refreshAssetPreviewsSchema.shape,
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      },
      (args) => refreshAssetPreviewsImpl(ctx, args),
    ),
  (server, ctx) =>
    server.registerTool(
      "install_library_package",
      {
        title: "Install library package",
        description:
          "Install a local tdmcp component package folder, .zip, .tox, or manifest into an explicit project/user package scope, or preserve the legacy dest_dir/<packageName> form. Project scope requires project_dir and uses <project_dir>/.tdmcp/packages. Use inspect_component_manifest first for unknown packages. This copies or extracts files, refuses replacement unless overwrite=true, rejects symlinked directory trees, and returns scope plus resolved paths.",
        inputSchema: installLibraryPackageSchema.shape,
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      },
      (args) => installLibraryPackageImpl(ctx, args),
    ),
  // Campaign Wave 4 (backlog 2026-05-29):
  registerDiffLibraryAssets,
  registerExportExternalizedTree,
  registerImportRecipeFromUrl,
  registerExportPaletteComponent,
  registerMarketplaceIndexSeed,
  // Campaign BEYOND Wave 3 (backlog 2026-05-30 — v0.7.0):
  registerProvenanceStamp,
  registerChecksumAndVerifyPack,
  // Campaign BEYOND Wave 5 (backlog 2026-05-30 — v0.7.0):
  registerCuratedCollectionPack,
  registerComponentChangelogTrail,
  // Ingest-extend Wave 3 sub-batch A (campaign 2026-05-31 — v0.9.0):
  registerGenerativeClassicsPack,
];
