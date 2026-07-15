import { getDeferredPackage, resolvePackage } from "./registry.js";
import type { DoctorCheck, PackageDoctorReport, PackageManifest } from "./types.js";

export interface DoctorOptions {
  /** Live TouchDesigner build string (e.g. "2025.30770") when the bridge is reachable. */
  liveBuild?: string;
}

/** Parses a TD build like "2025.30770" into a comparable numeric tuple [2025, 30770]. */
function parseBuild(build: string): number[] {
  return build
    .split(/[^0-9]+/)
    .filter((part) => part.length > 0)
    .map((part) => Number.parseInt(part, 10))
    .filter((n) => Number.isFinite(n));
}

/** true when `build` is strictly older than `min` (both TD build strings). */
function buildIsOlder(build: string, min: string): boolean {
  const a = parseBuild(build);
  const b = parseBuild(min);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

/**
 * Emits an honest TD-build gate check. Offline (no live build): a loud warning that states
 * the gate so the AI/artist can verify before staging. Live build below the gate: a warning
 * with the detected build and the fallback. Live build at/above the gate: ok.
 */
function versionGateCheck(pkg: PackageManifest, liveBuild?: string): DoctorCheck | undefined {
  const gate = pkg.versionGate;
  if (!gate) return undefined;
  const fallback = gate.fallback ? ` ${gate.fallback}` : "";
  if (!liveBuild) {
    return {
      id: "version-gate",
      status: "warning",
      message: `Requires TouchDesigner build ${gate.minBuild}+. ${gate.reason}${fallback} (TouchDesigner offline — running build not detected; verify before staging.)`,
    };
  }
  if (buildIsOlder(liveBuild, gate.minBuild)) {
    return {
      id: "version-gate",
      status: "warning",
      message: `Your TouchDesigner build (${liveBuild}) predates the required ${gate.minBuild}. ${gate.reason}${fallback}`,
    };
  }
  return {
    id: "version-gate",
    status: "ok",
    message: `TouchDesigner build ${liveBuild} satisfies the ${gate.minBuild}+ requirement.`,
  };
}

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

export function doctorPackage(idOrAlias: string, opts: DoctorOptions = {}): PackageDoctorReport {
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

  const gateCheck = versionGateCheck(pkg, opts.liveBuild);
  const checks: DoctorCheck[] = [
    supportCheck(pkg),
    ...(gateCheck ? [gateCheck] : []),
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
