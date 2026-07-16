import { existsSync, lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import {
  assertSafeSkillRelativePath,
  compareUtf8Bytewise,
  hashCanonicalSkillFiles,
} from "./catalog.js";
import {
  type CanonicalSkillRecord,
  CURATED_AGENT_SKILLS,
  isCuratedSkillName,
  SKILL_CATALOG_LIMITS,
  SKILL_MANIFEST_FILENAME,
  SKILL_MANIFEST_SCHEMA_VERSION,
  SKILL_METADATA_MAX_BYTES,
  SKILL_OWNED_NAMESPACE,
  SKILL_PRODUCT,
  SKILL_SOURCE_KIND,
  type SkillHost,
  SkillManagerError,
  type SkillManifest,
  type SkillScope,
} from "./types.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const skillFileSchema = z
  .object({
    path: z.string().min(1),
    sha256: sha256Schema,
    size: z.number().int().nonnegative(),
  })
  .strict();

const canonicalSkillSchema = z
  .object({
    name: z.string().min(1),
    relative_path: z.string().min(1),
    version: z.string().min(1),
    tree_sha256: sha256Schema,
    files: z.array(skillFileSchema),
    source_path: z.string().min(1),
  })
  .strict();

export const skillManifestSchema = z
  .object({
    schema_version: z.literal(SKILL_MANIFEST_SCHEMA_VERSION),
    product: z.literal(SKILL_PRODUCT),
    host: z.enum(["codex", "claude"]),
    scope: z.enum(["project", "user"]),
    target_root: z.string().min(1),
    manifest_path: z.string().min(1),
    owned_namespace: z.literal(SKILL_OWNED_NAMESPACE),
    source: z
      .object({
        kind: z.literal(SKILL_SOURCE_KIND),
        package_version: z.string().min(1),
        bundle_version: z.string().min(1),
      })
      .strict(),
    installed_at: z.iso.datetime(),
    updated_at: z.iso.datetime(),
    skills: z.array(canonicalSkillSchema),
  })
  .strict();

type ParsedManifest = z.infer<typeof skillManifestSchema>;
type ParsedSkill = ParsedManifest["skills"][number];
type ParsedSkillFile = ParsedSkill["files"][number];
type CuratedSkillDescriptor = (typeof CURATED_AGENT_SKILLS)[number];

function validateManifestSkillOrder(skill: ParsedSkill, seen: Set<string>, prior: string): string {
  if (!isCuratedSkillName(skill.name)) {
    throw new SkillManagerError("INVALID_MANIFEST", `Unknown owned skill: ${skill.name}`);
  }
  if (seen.has(skill.name) || (prior !== "" && compareUtf8Bytewise(prior, skill.name) >= 0)) {
    throw new SkillManagerError("INVALID_MANIFEST", "Manifest skills must be unique and sorted.");
  }
  seen.add(skill.name);
  return skill.name;
}

function validateManifestSkillIdentity(skill: ParsedSkill): CuratedSkillDescriptor {
  if (skill.relative_path !== skill.name) {
    throw new SkillManagerError(
      "INVALID_MANIFEST",
      `Manifest path does not match owned skill ${skill.name}.`,
    );
  }
  assertSafeSkillRelativePath(skill.relative_path, "Manifest skill path");
  if (skill.source_path !== `skills/curated/${skill.name}`) {
    throw new SkillManagerError(
      "INVALID_MANIFEST",
      `Manifest source path does not match ${skill.name}.`,
    );
  }
  const descriptor = CURATED_AGENT_SKILLS.find((candidate) => candidate.name === skill.name);
  if (!descriptor || skill.version !== descriptor.version) {
    throw new SkillManagerError(
      "INVALID_MANIFEST",
      `Manifest version is invalid for ${skill.name}.`,
    );
  }
  return descriptor;
}

interface ManifestFileAccumulator {
  seen: Set<string>;
  prior: string;
  treeBytes: number;
}

function appendManifestFile(
  skillName: string,
  file: ParsedSkillFile,
  accumulator: ManifestFileAccumulator,
): void {
  assertSafeSkillRelativePath(file.path, "Manifest file path");
  if (
    accumulator.seen.has(file.path) ||
    (accumulator.prior !== "" && compareUtf8Bytewise(accumulator.prior, file.path) >= 0)
  ) {
    throw new SkillManagerError(
      "INVALID_MANIFEST",
      `Manifest files for ${skillName} must be unique and sorted.`,
    );
  }
  accumulator.seen.add(file.path);
  accumulator.prior = file.path;
  if (file.size > SKILL_CATALOG_LIMITS.maxFileBytes) {
    throw new SkillManagerError("INVALID_MANIFEST", `Manifest file is too large: ${file.path}.`);
  }
  accumulator.treeBytes += file.size;
  if (accumulator.treeBytes > SKILL_CATALOG_LIMITS.maxTreeBytes) {
    throw new SkillManagerError("INVALID_MANIFEST", `Manifest tree is too large: ${skillName}.`);
  }
}

function validateExpectedManifestFiles(
  skill: ParsedSkill,
  descriptor: CuratedSkillDescriptor,
): void {
  const expectedFiles = [...descriptor.files].sort(compareUtf8Bytewise);
  const pathsDiffer = skill.files.some((file, index) => file.path !== expectedFiles[index]);
  if (skill.files.length !== expectedFiles.length || pathsDiffer) {
    throw new SkillManagerError(
      "INVALID_MANIFEST",
      `Manifest files or tree hash are invalid for ${skill.name}.`,
    );
  }
  if (hashCanonicalSkillFiles(skill.files) !== skill.tree_sha256) {
    throw new SkillManagerError(
      "INVALID_MANIFEST",
      `Manifest files or tree hash are invalid for ${skill.name}.`,
    );
  }
}

function validateManifestSkillFiles(skill: ParsedSkill, descriptor: CuratedSkillDescriptor): void {
  if (skill.files.length > SKILL_CATALOG_LIMITS.maxFilesPerSkill) {
    throw new SkillManagerError(
      "INVALID_MANIFEST",
      `Manifest has too many files for ${skill.name}.`,
    );
  }
  const accumulator: ManifestFileAccumulator = { seen: new Set(), prior: "", treeBytes: 0 };
  for (const file of skill.files) appendManifestFile(skill.name, file, accumulator);
  validateExpectedManifestFiles(skill, descriptor);
}

function validateManifestRecords(manifest: z.infer<typeof skillManifestSchema>): void {
  if (manifest.skills.length > SKILL_CATALOG_LIMITS.maxSkills) {
    throw new SkillManagerError("INVALID_MANIFEST", "Manifest contains too many skills.");
  }
  const seen = new Set<string>();
  let prior = "";
  for (const skill of manifest.skills) {
    prior = validateManifestSkillOrder(skill, seen, prior);
    const descriptor = validateManifestSkillIdentity(skill);
    validateManifestSkillFiles(skill, descriptor);
  }
}

export function manifestPathFor(targetRoot: string): string {
  return join(targetRoot, SKILL_MANIFEST_FILENAME);
}

export function parseSkillManifest(
  raw: string,
  expected: { targetRoot: string; host: SkillHost; scope: SkillScope },
): SkillManifest {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new SkillManagerError("INVALID_MANIFEST", "The tdmcp skill manifest is not valid JSON.");
  }
  const parsed = skillManifestSchema.safeParse(json);
  if (!parsed.success) {
    throw new SkillManagerError("INVALID_MANIFEST", "The tdmcp skill manifest is invalid.");
  }
  const targetRoot = resolve(expected.targetRoot);
  const expectedManifestPath = manifestPathFor(targetRoot);
  if (!isAbsolute(parsed.data.target_root) || resolve(parsed.data.target_root) !== targetRoot) {
    throw new SkillManagerError("INVALID_MANIFEST", "Manifest target_root does not match target.");
  }
  if (
    !isAbsolute(parsed.data.manifest_path) ||
    resolve(parsed.data.manifest_path) !== expectedManifestPath
  ) {
    throw new SkillManagerError("INVALID_MANIFEST", "Manifest path does not match target.");
  }
  if (parsed.data.host !== expected.host || parsed.data.scope !== expected.scope) {
    throw new SkillManagerError(
      "INVALID_MANIFEST",
      "Manifest host or scope does not match target.",
    );
  }
  validateManifestRecords(parsed.data);
  return parsed.data as SkillManifest;
}

export function readSkillManifest(
  targetRoot: string,
  host: SkillHost,
  scope: SkillScope,
): { manifest: SkillManifest | null; raw: string | null } {
  const path = manifestPathFor(targetRoot);
  if (!existsSync(path)) return { manifest: null, raw: null };
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new SkillManagerError(
      "INVALID_MANIFEST",
      "The tdmcp skill manifest is not a regular file.",
    );
  }
  if (info.size > SKILL_METADATA_MAX_BYTES) {
    throw new SkillManagerError("INVALID_MANIFEST", "The tdmcp skill manifest is too large.");
  }
  const raw = readFileSync(path, "utf8");
  if (Buffer.byteLength(raw, "utf8") > SKILL_METADATA_MAX_BYTES) {
    throw new SkillManagerError("INVALID_MANIFEST", "The tdmcp skill manifest is too large.");
  }
  return { manifest: parseSkillManifest(raw, { targetRoot, host, scope }), raw };
}

export function buildSkillManifest(input: {
  prior: SkillManifest | null;
  host: SkillHost;
  scope: SkillScope;
  targetRoot: string;
  packageVersion: string;
  bundleVersion: string;
  now: string;
  skills: CanonicalSkillRecord[];
}): SkillManifest {
  const targetRoot = resolve(input.targetRoot);
  return {
    schema_version: SKILL_MANIFEST_SCHEMA_VERSION,
    product: SKILL_PRODUCT,
    host: input.host,
    scope: input.scope,
    target_root: targetRoot,
    manifest_path: manifestPathFor(targetRoot),
    owned_namespace: SKILL_OWNED_NAMESPACE,
    source: {
      kind: SKILL_SOURCE_KIND,
      package_version: input.packageVersion,
      bundle_version: input.bundleVersion,
    },
    installed_at: input.prior?.installed_at ?? input.now,
    updated_at: input.now,
    skills: [...input.skills].sort((a, b) => compareUtf8Bytewise(a.name, b.name)),
  };
}

export function serializeSkillManifest(manifest: SkillManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
