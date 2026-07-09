import { z } from "zod";
import { doctorPackage } from "../../packages/doctor.js";
import { installPackage, uninstallPackage } from "../../packages/installer.js";
import { createPackagePaths } from "../../packages/paths.js";
import { listPackages, resolvePackage, searchPackages } from "../../packages/registry.js";
import { readPackageState } from "../../packages/state.js";
import { errorResult, structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const managePackagesSchema = z.object({
  action: z
    .enum(["search", "list", "info", "doctor", "install", "uninstall", "path"])
    .describe("Package-manager action to run."),
  package_id: z
    .string()
    .optional()
    .describe("Package id or alias, e.g. 'mediapipe', 'raytk', or 'shader-park-td'."),
  query: z.string().optional().describe("Search query for action='search'."),
  installed: z.boolean().default(false).describe("For action='list', include installed state."),
  dry_run: z
    .boolean()
    .default(true)
    .describe("For action='install', plan safely without downloading or mutating by default."),
  project_path: z
    .string()
    .default("/project1")
    .describe("TouchDesigner project COMP for optional live import."),
  name: z.string().optional().describe("Optional custom TD node name for live import."),
  pin: z
    .string()
    .optional()
    .describe("Optional Git ref/tag to stage instead of the manifest default."),
  yes: z
    .boolean()
    .default(false)
    .describe("Allow replacement of existing staged files / TD package target when applicable."),
  allow_python_deps: z
    .boolean()
    .default(false)
    .describe("Acknowledge optional Python dependency guidance; does not run pip."),
  allow_external: z
    .boolean()
    .default(false)
    .describe(
      "Acknowledge optional external dependency guidance; does not configure apps/services.",
    ),
  packages_root: z
    .string()
    .optional()
    .describe("Advanced override for package state/cache root. Defaults to ~/.tdmcp/packages."),
});
type ManagePackagesArgs = z.infer<typeof managePackagesSchema>;

function requirePackageId(args: ManagePackagesArgs): string | undefined {
  return args.package_id?.trim() || undefined;
}

// Best-effort live TD build detection so version-gated packages (e.g. RayTK, which needs the
// 2025.30770 experimental build) warn against the running build. Returns undefined when the
// bridge is unreachable, which the doctor treats as an offline gate warning.
// Prefer `build` (the YYYY.NNNNN number the gate compares against, e.g. "2025.32820"); the
// `td_version` field is the product series (e.g. "099") and must NOT drive the numeric gate.
async function detectLiveBuild(ctx: ToolContext): Promise<string | undefined> {
  try {
    const info = await ctx.client.getInfo();
    return info.build ?? info.td_version;
  } catch {
    return undefined;
  }
}

export async function managePackagesImpl(ctx: ToolContext, args: ManagePackagesArgs) {
  try {
    if (args.action === "search") {
      const packages = searchPackages(args.query ?? "");
      return structuredResult(`Found ${packages.length} package search result(s).`, { packages });
    }

    if (args.action === "list") {
      const paths = createPackagePaths({ rootDir: args.packages_root });
      const available = listPackages();
      const installed = args.installed ? readPackageState(paths).packages : [];
      return structuredResult(
        `Listed ${available.length} available package(s) and ${installed.length} installed package(s).`,
        { available, installed },
      );
    }

    if (args.action === "info") {
      const id = requirePackageId(args);
      if (!id) return errorResult("A `package_id` is required for package info.");
      const pkg = resolvePackage(id);
      if (!pkg) return errorResult(`Unknown package: ${id}`);
      return structuredResult(`${pkg.displayName}: ${pkg.supportLevel}.`, { package: pkg });
    }

    if (args.action === "doctor") {
      const id = requirePackageId(args);
      if (!id) return errorResult("A `package_id` is required for package doctor.");
      const report = doctorPackage(id, { liveBuild: await detectLiveBuild(ctx) });
      return structuredResult(`Package doctor: ${report.status}.`, { report });
    }

    if (args.action === "install") {
      const id = requirePackageId(args);
      if (!id) return errorResult("A `package_id` is required for package install.");
      const report = await installPackage(id, {
        rootDir: args.packages_root,
        dryRun: args.dry_run,
        projectPath: args.project_path,
        name: args.name,
        pin: args.pin,
        yes: args.yes,
        allowPythonDeps: args.allow_python_deps,
        allowExternal: args.allow_external,
        bridge: args.dry_run
          ? { mode: "offline" }
          : {
              mode: "client",
              getInfo: () => ctx.client.getInfo(),
              executePythonScript: (script, returnOutput) =>
                ctx.client.executePythonScript(script, returnOutput),
              getNodeErrors: (path) => ctx.client.getNodeErrors(path),
            },
      });
      return structuredResult(`${report.package.displayName}: ${report.status}.`, { report });
    }

    if (args.action === "uninstall") {
      const id = requirePackageId(args);
      if (!id) return errorResult("A `package_id` is required for package uninstall.");
      const report = await uninstallPackage(id, { rootDir: args.packages_root, yes: args.yes });
      return structuredResult(
        `${report.packageId}: ${report.removed ? "removed" : "not installed"}.`,
        {
          report,
        },
      );
    }

    const paths = createPackagePaths({ rootDir: args.packages_root });
    return structuredResult(`Package root: ${paths.root}`, { paths });
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
}

export const registerManagePackages: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "manage_packages",
    {
      title: "Manage TouchDesigner community packages",
      description:
        "Search, list, inspect, doctor, dry-run install, stage, and uninstall manifest-driven TouchDesigner community packages. Dry-run is the default. Installs stage packages under ~/.tdmcp/packages and only import into TouchDesigner when the bridge is reachable and the package has a safe .tox import path. This tool never runs third-party scripts, pip installs, model downloads, or external app setup.",
      inputSchema: managePackagesSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    (args) => managePackagesImpl(ctx, args),
  );
};
