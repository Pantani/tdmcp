import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { assertZipToolAvailable, extractZipSafe } from "./archive.js";
import { scanPackageArtifacts } from "./artifacts.js";
import { importPackageViaBridge } from "./bridge.js";
import {
  createGithubDownloadPlan,
  downloadToFile,
  resolveGithubReleaseDownloadPlan,
} from "./github.js";
import { createPackagePaths, safePackageSegment } from "./paths.js";
import {
  createAdHocGithubManifest,
  getDeferredPackage,
  normalizePackageId,
  resolvePackage,
} from "./registry.js";
import { readPackageState, upsertPackageState, writePackageState } from "./state.js";
import type {
  InstalledPackageStatus,
  PackageDownloadPlan,
  PackageInstallReport,
  PackageManagerOptions,
  PackageManifest,
  PackageUninstallReport,
} from "./types.js";

export function isRepoSlug(repo: string): boolean {
  return /^[\w.-]+\/[\w.-]+$/.test(repo);
}

function resolveInstallManifest(idOrAlias: string): PackageManifest | undefined {
  return (
    resolvePackage(idOrAlias) ??
    (isRepoSlug(idOrAlias) ? createAdHocGithubManifest(idOrAlias) : undefined)
  );
}

function manualWarning(pkg: PackageManifest): string {
  if (pkg.supportLevel === "doctor-only") {
    return `${pkg.displayName} is doctor-only: external dependencies must be installed manually; tdmcp will not download models, run pip, or configure external apps.`;
  }
  return `${pkg.displayName} is staged for manual import/setup.`;
}

function nextStepsFor(pkg: PackageManifest, status: PackageInstallReport["status"]): string[] {
  if (status === "planned") {
    return [`Run \`tdmcp install ${pkg.id}\` to stage the package, or keep using --dry-run.`];
  }
  if (status === "imported") {
    return [`Inspect the imported package under ${pkg.importHints.namespace}.`];
  }
  if (status === "manual") {
    return [...pkg.installStrategy.manualSteps, ...pkg.importHints.manualSteps];
  }
  return [
    `Open staged files on disk or import a selected .tox into ${pkg.importHints.namespace}.`,
    ...pkg.importHints.manualSteps,
  ];
}

function statusForState(
  status: PackageInstallReport["status"],
  pkg: PackageManifest,
): InstalledPackageStatus {
  if (status === "imported") return "imported";
  if (status === "manual") return pkg.supportLevel === "doctor-only" ? "doctor-only" : "manual";
  return "staged";
}

function downloadPlanFor(pkg: PackageManifest, pin?: string): PackageDownloadPlan | undefined {
  if (pkg.source.type !== "github") return undefined;
  return createGithubDownloadPlan(pkg, pin);
}

function makeRecord(
  pkg: PackageManifest,
  report: PackageInstallReport,
  ref: string,
  now: string,
  previousInstalledAt?: string,
) {
  return {
    id: pkg.id,
    displayName: pkg.displayName,
    sourceUrl: pkg.source.url,
    ref,
    status: statusForState(report.status, pkg),
    stagedPath: report.stagedPath,
    artifacts: report.artifacts,
    bridgeTargetPath: report.bridge?.targetPath,
    warnings: report.warnings,
    installedAt: previousInstalledAt ?? now,
    updatedAt: now,
  };
}

export async function installPackage(
  idOrAlias: string,
  opts: PackageManagerOptions = {},
): Promise<PackageInstallReport> {
  const paths = createPackagePaths({ rootDir: opts.rootDir });
  const pkg = resolveInstallManifest(idOrAlias);
  if (!pkg) {
    const deferred = getDeferredPackage(idOrAlias);
    const reason = deferred
      ? `${idOrAlias} is deferred and not an install target: ${deferred.reason}`
      : `Unknown package: ${idOrAlias}`;
    throw new Error(reason);
  }

  const dryRun = Boolean(opts.dryRun);
  let download = downloadPlanFor(pkg, opts.pin);
  const warnings: string[] = [];
  if (pkg.externalDependencies.length > 0) {
    for (const dep of pkg.externalDependencies) {
      warnings.push(`${dep.name}: ${dep.notes}`);
    }
  }

  const baseReport = {
    command: "install" as const,
    dryRun,
    package: pkg,
    root: paths.root,
    download,
    artifacts: [],
    warnings,
  };

  if (dryRun) {
    return {
      ...baseReport,
      status: "planned",
      nextSteps: nextStepsFor(pkg, "planned"),
    };
  }

  if (pkg.supportLevel === "doctor-only" || pkg.installStrategy.mode === "manual") {
    const report: PackageInstallReport = {
      ...baseReport,
      status: "manual",
      warnings: [manualWarning(pkg), ...warnings],
      nextSteps: nextStepsFor(pkg, "manual"),
    };
    const now = (opts.now ?? (() => new Date()))().toISOString();
    const previous = readPackageState(paths).packages.find((record) => record.id === pkg.id);
    upsertPackageState(
      paths,
      makeRecord(pkg, report, opts.pin ?? pkg.source.defaultRef, now, previous?.installedAt),
    );
    return report;
  }

  if (!download) {
    const report: PackageInstallReport = {
      ...baseReport,
      status: "manual",
      warnings: [
        `${pkg.displayName} has no downloadable GitHub source in its manifest.`,
        ...warnings,
      ],
      nextSteps: nextStepsFor(pkg, "manual"),
    };
    return report;
  }

  if (
    (pkg.installStrategy.preferReleaseAsset || opts.assetFilter) &&
    !opts.pin &&
    (!opts.downloader || opts.fetchImpl || opts.assetFilter) &&
    pkg.source.type === "github"
  ) {
    try {
      download =
        (await resolveGithubReleaseDownloadPlan(pkg, opts.fetchImpl, opts.assetFilter)) ?? download;
    } catch (err) {
      if (opts.assetFilter) throw err;
      warnings.push(
        `Could not resolve latest release asset; falling back to source archive: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  const segment = safePackageSegment(pkg.id);
  const archiveDir = join(paths.cache, segment);
  const archivePath = join(archiveDir, download.archiveName);
  const stagedPath = join(paths.installRoot, segment);
  if (download.kind === "zip" && !opts.extractor) assertZipToolAvailable();
  mkdirSync(archiveDir, { recursive: true });
  mkdirSync(paths.installRoot, { recursive: true });
  rmSync(stagedPath, { recursive: true, force: true });
  mkdirSync(stagedPath, { recursive: true });

  const downloader = opts.downloader ?? downloadToFile;
  const extractor = opts.extractor ?? extractZipSafe;
  await downloader(download.url, archivePath);
  if (download.kind === "file") {
    copyFileSync(archivePath, join(stagedPath, download.archiveName));
  } else {
    await extractor(archivePath, stagedPath);
  }

  const artifacts = scanPackageArtifacts(stagedPath);
  if (artifacts.length === 0) warnings.push("No files were detected after extraction.");
  if (
    pkg.installStrategy.mode === "stage-only" ||
    pkg.installStrategy.mode === "project-template"
  ) {
    warnings.push(
      `${pkg.displayName} is staged as ${pkg.installStrategy.mode}; import selectively.`,
    );
  }

  const bridge = await importPackageViaBridge(opts.bridge, pkg, artifacts, {
    projectPath: opts.projectPath ?? "/project1",
    name: opts.name,
    yes: opts.yes,
  });
  warnings.push(...bridge.warnings);
  if (bridge.fatal) warnings.push(bridge.fatal);

  const imported = bridge.connected && bridge.imported && !bridge.fatal;
  const report: PackageInstallReport = {
    ...baseReport,
    download,
    status: imported ? "imported" : "staged",
    cachePath: archivePath,
    stagedPath,
    artifacts,
    bridge,
    warnings,
    nextSteps: nextStepsFor(pkg, imported ? "imported" : "staged"),
  };

  const now = (opts.now ?? (() => new Date()))().toISOString();
  const previous = readPackageState(paths).packages.find((record) => record.id === pkg.id);
  upsertPackageState(paths, makeRecord(pkg, report, download.ref, now, previous?.installedAt));
  return report;
}

export async function uninstallPackage(
  idOrAlias: string,
  opts: PackageManagerOptions = {},
): Promise<PackageUninstallReport> {
  const paths = createPackagePaths({ rootDir: opts.rootDir });
  const pkg = resolveInstallManifest(idOrAlias);
  const packageId = pkg?.id ?? normalizePackageId(idOrAlias);
  const state = readPackageState(paths);
  const existing = state.packages.find((record) => record.id === packageId);
  if (!existing) {
    return {
      command: "uninstall",
      packageId,
      removed: false,
      warnings: [`${packageId} is not recorded as installed.`],
      nextSteps: ["Run `tdmcp list --installed` to inspect installed package state."],
    };
  }

  if (
    existing.stagedPath &&
    existsSync(existing.stagedPath) &&
    (opts.yes || pkg?.uninstallStrategy.mode !== "manual")
  ) {
    rmSync(existing.stagedPath, { recursive: true, force: true });
  }
  writePackageState(paths, {
    version: 1,
    packages: state.packages.filter((record) => record.id !== packageId),
  });
  return {
    command: "uninstall",
    packageId,
    removed: true,
    stagedPath: existing.stagedPath,
    warnings:
      existing.bridgeTargetPath || pkg?.uninstallStrategy.mode === "manual"
        ? ["Delete any imported TouchDesigner nodes or external app files manually."]
        : [],
    nextSteps: ["Run `tdmcp list --installed` to confirm package state."],
  };
}
