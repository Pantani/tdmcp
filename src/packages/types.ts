import { z } from "zod";

export const PackageTypeSchema = z.enum([
  "tox",
  "component",
  "toolkit",
  "project-template",
  "external-adapter",
  "doctor-only",
  "collection",
]);
export type PackageType = z.infer<typeof PackageTypeSchema>;

export const SupportLevelSchema = z.enum(["full", "stage-only", "doctor-only", "deferred"]);
export type SupportLevel = z.infer<typeof SupportLevelSchema>;

export const InstallModeSchema = z.enum(["tox-import", "stage-only", "project-template", "manual"]);
export type InstallMode = z.infer<typeof InstallModeSchema>;

export const SourceSchema = z.object({
  type: z.enum(["github", "official-docs", "manual"]),
  url: z.string().url(),
  repo: z.string().optional(),
  defaultRef: z.string().default("main"),
});
export type PackageSource = z.infer<typeof SourceSchema>;

export const ExternalDependencySchema = z.object({
  name: z.string().min(1),
  kind: z.enum(["python", "model", "service", "application", "hardware", "daw", "gpu", "other"]),
  required: z.boolean().default(true),
  notes: z.string().min(1),
});
export type ExternalDependency = z.infer<typeof ExternalDependencySchema>;

export const InstallStrategySchema = z.object({
  mode: InstallModeSchema,
  preferReleaseAsset: z.boolean().default(false),
  releaseAssetPattern: z.string().optional(),
  importableExtensions: z.array(z.string()).default([".tox"]),
  stageSubdir: z.string().optional(),
  manualSteps: z.array(z.string()).default([]),
});
export type InstallStrategy = z.infer<typeof InstallStrategySchema>;

export const HealthCheckSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  severity: z.enum(["info", "warning", "required"]).default("info"),
});
export type HealthCheck = z.infer<typeof HealthCheckSchema>;

export const ImportHintsSchema = z
  .object({
    namespace: z.string().default("/project1/tdmcp_packages"),
    preferredArtifacts: z.array(z.string()).default([]),
    manualSteps: z.array(z.string()).default([]),
  })
  .default({
    namespace: "/project1/tdmcp_packages",
    preferredArtifacts: [],
    manualSteps: [],
  });
export type ImportHints = z.infer<typeof ImportHintsSchema>;

export const UninstallStrategySchema = z.object({
  mode: z.enum(["state-only", "delete-staged", "manual"]).default("delete-staged"),
  notes: z.string().min(1),
});
export type UninstallStrategy = z.infer<typeof UninstallStrategySchema>;

/**
 * A hard TouchDesigner build gate for packages whose current release only runs on a
 * specific TD build (e.g. RayTK 0.46 requires the 2025.30770 experimental build and is
 * NOT compatible with 2023.x). `minBuild` is a TD build string like "2025.30770"; doctor
 * compares the live `app.version` against it and warns when the running build predates the
 * gate, offering `fallback` (e.g. pin an older package release for older TD builds).
 */
export const VersionGateSchema = z.object({
  minBuild: z.string().min(1),
  reason: z.string().min(1),
  fallback: z.string().min(1).optional(),
});
export type VersionGate = z.infer<typeof VersionGateSchema>;

export const PackageManifestSchema = z.object({
  id: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  displayName: z.string().min(1),
  description: z.string().min(1),
  homepage: z.string().url(),
  source: SourceSchema,
  license: z.string().min(1),
  tags: z.array(z.string()).default([]),
  packageType: PackageTypeSchema,
  supportLevel: SupportLevelSchema,
  platforms: z.array(z.string()).default(["macos", "windows"]),
  tdVersionRange: z.string().optional(),
  versionGate: VersionGateSchema.optional(),
  requiresTouchDesignerBridge: z.boolean().default(false),
  externalDependencies: z.array(ExternalDependencySchema).default([]),
  installStrategy: InstallStrategySchema,
  healthChecks: z.array(HealthCheckSchema).default([]),
  importHints: ImportHintsSchema,
  uninstallStrategy: UninstallStrategySchema,
  securityNotes: z.array(z.string()).default([]),
});
export type PackageManifest = z.infer<typeof PackageManifestSchema>;

export const DeferredPackageSchema = z.object({
  id: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  displayName: z.string().min(1),
  reason: z.string().min(1),
});
export type DeferredPackage = z.infer<typeof DeferredPackageSchema>;

export const PackageArtifactSchema = z.object({
  kind: z.enum(["tox", "toe", "td", "python", "doc", "asset", "other"]),
  relativePath: z.string().min(1),
  absolutePath: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  importable: z.boolean().default(false),
});
export type PackageArtifact = z.infer<typeof PackageArtifactSchema>;

export const InstalledPackageStatusSchema = z.enum(["staged", "imported", "manual", "doctor-only"]);
export type InstalledPackageStatus = z.infer<typeof InstalledPackageStatusSchema>;

export const InstalledPackageSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  sourceUrl: z.string().url(),
  ref: z.string().min(1),
  status: InstalledPackageStatusSchema,
  stagedPath: z.string().min(1).optional(),
  artifacts: z.array(PackageArtifactSchema).default([]),
  bridgeTargetPath: z.string().optional(),
  warnings: z.array(z.string()).default([]),
  installedAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type InstalledPackage = z.infer<typeof InstalledPackageSchema>;

export const PackageStateSchema = z.object({
  version: z.literal(1),
  packages: z.array(InstalledPackageSchema).default([]),
});
export type PackageState = z.infer<typeof PackageStateSchema>;

export type PackageInstallStatus = "planned" | "staged" | "imported" | "manual" | "failed";

export interface PackageDownloadPlan {
  url: string;
  ref: string;
  archiveName: string;
  kind: "zip" | "file";
  strategy: "github-archive" | "github-release-asset";
}

export interface PackageBridgeReport {
  connected: boolean;
  imported?: boolean;
  targetPath?: string;
  marker?: string;
  nodeErrors?: unknown[];
  warnings: string[];
  fatal?: string;
}

export interface PackageInstallReport {
  command: "install";
  dryRun: boolean;
  package: PackageManifest;
  status: PackageInstallStatus;
  root: string;
  cachePath?: string;
  stagedPath?: string;
  download?: PackageDownloadPlan;
  artifacts: PackageArtifact[];
  bridge?: PackageBridgeReport;
  warnings: string[];
  nextSteps: string[];
}

export interface PackageUninstallReport {
  command: "uninstall";
  packageId: string;
  removed: boolean;
  stagedPath?: string;
  warnings: string[];
  nextSteps: string[];
}

export interface PackagePaths {
  root: string;
  cache: string;
  installRoot: string;
  installedRegistry: string;
}

export interface PackageBridgeOffline {
  mode: "offline";
}

export interface PackageBridgeClient {
  mode: "client";
  getInfo: () => Promise<unknown>;
  executePythonScript: (
    script: string,
    returnOutput?: boolean,
  ) => Promise<{ stdout?: string; result?: unknown }>;
  getNodeErrors?: (path: string) => Promise<{ errors?: unknown[] }>;
}

export type PackageBridge = PackageBridgeOffline | PackageBridgeClient;

export interface PackageManagerOptions {
  rootDir?: string;
  dryRun?: boolean;
  projectPath?: string;
  name?: string;
  pin?: string;
  assetFilter?: string;
  yes?: boolean;
  allowPythonDeps?: boolean;
  allowExternal?: boolean;
  downloader?: (url: string, filePath: string) => Promise<void>;
  extractor?: (archivePath: string, destDir: string) => Promise<void>;
  fetchImpl?: typeof fetch;
  bridge?: PackageBridge;
  now?: () => Date;
}

export interface DoctorCheck {
  id: string;
  status: "ok" | "warning" | "manual" | "blocked";
  message: string;
}

export interface PackageDoctorReport {
  package?: PackageManifest;
  deferred?: DeferredPackage;
  status: "ok" | "warning" | "manual" | "deferred" | "unknown";
  checks: DoctorCheck[];
  nextSteps: string[];
}

export interface PackageCliResult {
  stdout: string;
  stderr: string;
  code: number;
}
