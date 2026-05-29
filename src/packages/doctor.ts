import { getDeferredPackage, resolvePackage } from "./registry.js";
import type { DoctorCheck, PackageDoctorReport, PackageManifest } from "./types.js";

function dependencyChecks(pkg: PackageManifest): DoctorCheck[] {
  return pkg.externalDependencies.map((dep) => ({
    id: `external:${dep.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    status: dep.required ? "manual" : "warning",
    message: `${dep.name}: ${dep.notes}`,
  }));
}

function supportCheck(pkg: PackageManifest): DoctorCheck {
  if (pkg.supportLevel === "full") {
    return {
      id: "support-level",
      status: "ok",
      message: `${pkg.displayName} has full package-manager dry-run/stage/status support.`,
    };
  }
  if (pkg.supportLevel === "stage-only") {
    return {
      id: "support-level",
      status: "manual",
      message: `${pkg.displayName} is staged as a project/template or collection; import selectively.`,
    };
  }
  return {
    id: "support-level",
    status: "manual",
    message: `${pkg.displayName} is doctor-only; tdmcp will not auto-install external runtimes.`,
  };
}

export function doctorPackage(idOrAlias: string): PackageDoctorReport {
  const pkg = resolvePackage(idOrAlias);
  if (!pkg) {
    const deferred = getDeferredPackage(idOrAlias);
    if (deferred) {
      return {
        deferred,
        status: "deferred",
        checks: [
          {
            id: "deferred",
            status: "blocked",
            message: deferred.reason,
          },
        ],
        nextSteps: [
          "Use this as a manual workflow/reference for now; it is not an install target.",
        ],
      };
    }
    return {
      status: "unknown",
      checks: [{ id: "unknown", status: "blocked", message: `Unknown package: ${idOrAlias}` }],
      nextSteps: ["Run `tdmcp search` to see supported package ids and aliases."],
    };
  }

  const checks: DoctorCheck[] = [
    supportCheck(pkg),
    ...dependencyChecks(pkg),
    ...pkg.healthChecks.map((check) => ({
      id: check.id,
      status: (check.severity === "required" ? "manual" : "warning") as DoctorCheck["status"],
      message: check.description,
    })),
  ];
  const hasManual = checks.some((check) => check.status === "manual" || check.status === "blocked");
  const hasWarning = checks.some((check) => check.status === "warning");
  const nextSteps = [
    ...pkg.installStrategy.manualSteps,
    ...pkg.importHints.manualSteps,
    ...pkg.externalDependencies.map((dep) => dep.notes),
  ].filter((step, index, arr) => step && arr.indexOf(step) === index);

  return {
    package: pkg,
    status: hasManual ? "manual" : hasWarning ? "warning" : "ok",
    checks,
    nextSteps:
      nextSteps.length > 0
        ? nextSteps
        : [`Run \`tdmcp install ${pkg.id} --dry-run --json\` before staging.`],
  };
}

export function doctorAllPackages(): PackageDoctorReport {
  return {
    status: "warning",
    checks: [
      {
        id: "package-doctor-summary",
        status: "warning",
        message: "Pass a package id for detailed doctor checks.",
      },
    ],
    nextSteps: ["Run `tdmcp doctor <lib> --json` for package-specific checks."],
  };
}
