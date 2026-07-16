export const SKILL_MANIFEST_SCHEMA_VERSION = 1 as const;
export const SKILL_MANIFEST_FILENAME = ".tdmcp-skills.json" as const;
export const SKILL_PRODUCT = "tdmcp" as const;
export const SKILL_OWNED_NAMESPACE = "tdmcp-" as const;
export const SKILL_SOURCE_KIND = "bundled" as const;
export const CURATED_SKILL_BUNDLE_VERSION = "1" as const;
export const SKILL_METADATA_MAX_BYTES = 512 * 1024;

export const CURATED_SKILL_NAMES = [
  "tdmcp-artist-workflows",
  "tdmcp-project-safety",
  "tdmcp-troubleshooting",
] as const;

/** Public, target-neutral source contract consumed by installer and bundle tooling. */
export const CURATED_AGENT_SKILLS = [
  {
    name: "tdmcp-artist-workflows",
    version: "1",
    source_path: "skills/curated/tdmcp-artist-workflows",
    hosts: ["codex", "claude"],
    files: ["SKILL.md"],
  },
  {
    name: "tdmcp-project-safety",
    version: "1",
    source_path: "skills/curated/tdmcp-project-safety",
    hosts: ["codex", "claude"],
    files: ["SKILL.md"],
  },
  {
    name: "tdmcp-troubleshooting",
    version: "1",
    source_path: "skills/curated/tdmcp-troubleshooting",
    hosts: ["codex", "claude"],
    files: ["SKILL.md"],
  },
] as const;

export type CuratedSkillName = (typeof CURATED_SKILL_NAMES)[number];
export type SkillHost = "codex" | "claude";
export type SkillScope = "project" | "user";
export type SkillAction = "status" | "install" | "update" | "uninstall";
export type SkillOperationKind = "install" | "update" | "remove" | "unchanged";
export type SkillResultStatus = "planned" | "applied" | "no_change" | "conflict" | "failed";
export type SkillState =
  | "not_installed"
  | "installed"
  | "outdated"
  | "missing"
  | "drifted"
  | "unowned_conflict";

export const SKILL_CATALOG_LIMITS = {
  maxSkills: 16,
  maxFilesPerSkill: 64,
  maxFileBytes: 1024 * 1024,
  maxTreeBytes: 4 * 1024 * 1024,
} as const;

export interface SkillFileRecord {
  path: string;
  sha256: string;
  size: number;
}

/**
 * Canonical, target-neutral record shared by installation and reproducible bundle creation.
 * Consumers must keep `files` sorted and must not add timestamps or destination paths.
 */
export interface CanonicalSkillRecord {
  name: CuratedSkillName;
  relative_path: CuratedSkillName;
  version: string;
  tree_sha256: string;
  files: SkillFileRecord[];
  source_path: `skills/curated/${CuratedSkillName}`;
}

export interface SkillManifest {
  schema_version: typeof SKILL_MANIFEST_SCHEMA_VERSION;
  product: typeof SKILL_PRODUCT;
  host: SkillHost;
  scope: SkillScope;
  target_root: string;
  manifest_path: string;
  owned_namespace: typeof SKILL_OWNED_NAMESPACE;
  source: {
    kind: typeof SKILL_SOURCE_KIND;
    package_version: string;
    bundle_version: string;
  };
  installed_at: string;
  updated_at: string;
  skills: CanonicalSkillRecord[];
}

export interface SkillOperation {
  operation: SkillOperationKind;
  name: CuratedSkillName;
  path: string;
  from_sha256?: string;
  to_sha256?: string;
}

export interface SkillStatus {
  name: CuratedSkillName;
  path: string;
  state: SkillState;
  source_sha256: string;
  installed_sha256?: string;
  owned: boolean;
}

export interface ManageAgentSkillsInput {
  action: SkillAction;
  host: SkillHost;
  scope: SkillScope;
  project_root?: string;
  skills?: string[];
  dry_run: boolean;
  force_owned_drift: boolean;
}

export interface ManageAgentSkillsResult {
  action: SkillAction;
  status: SkillResultStatus;
  dry_run: boolean;
  host: SkillHost;
  scope: SkillScope;
  target_root: string;
  manifest_path: string;
  source_version: string;
  planned: SkillOperation[];
  applied: SkillOperation[];
  skills: SkillStatus[];
  warnings: string[];
}

export type TransactionStep =
  | "after_staging"
  | "before_swap"
  | "after_swap"
  | "before_manifest"
  | "after_manifest";

export interface ManageAgentSkillsOptions {
  /** Bundled `skills/curated` root. Tests and bundle tooling inject this. */
  sourceRoot?: string;
  /** Home directory override. Tests must inject it. */
  homeDir?: string;
  /** Codex home override, before the process environment and ~/.codex fallback. */
  codexHome?: string;
  /** Project root supplied by a CLI caller when `project_root` is omitted. */
  projectRoot?: string;
  packageVersion?: string;
  bundleVersion?: string;
  now?: () => Date;
  randomId?: () => string;
  /** Test-only failure hook used to prove rollback. */
  onTransactionStep?: (step: TransactionStep, skillName?: CuratedSkillName) => void;
}

export class SkillManagerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SkillManagerError";
    this.code = code;
  }
}

export function isCuratedSkillName(value: string): value is CuratedSkillName {
  return (CURATED_SKILL_NAMES as readonly string[]).includes(value);
}
