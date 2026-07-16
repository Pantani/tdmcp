import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { doctorPackage } from "../../packages/doctor.js";
import { installPackage, uninstallPackage } from "../../packages/installer.js";
import { createPackagePaths } from "../../packages/paths.js";
import {
  type PackageQuarantineHandle,
  type PackageReconcileRecord,
  type ReconcilePackageNamespaceDependencies,
  reconcilePackageNamespace,
} from "../../packages/reconcile.js";
import { listPackages, resolvePackage, searchPackages } from "../../packages/registry.js";
import { resolvePackageStorage } from "../../packages/scopes.js";
import { readPackageState, writePackageState } from "../../packages/state.js";
import { errorResult, structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const managePackagesSchema = z.object({
  action: z
    .enum(["search", "list", "info", "doctor", "install", "uninstall", "path", "reconcile"])
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
  scope: z
    .enum(["user", "project"])
    .default("user")
    .describe("Package ownership scope. Project scope uses <project_dir>/.tdmcp/packages."),
  project_dir: z
    .string()
    .optional()
    .describe("Explicit local project directory; required when scope='project'."),
  packages_root: z
    .string()
    .optional()
    .describe("Advanced override for package state/cache root. Defaults to ~/.tdmcp/packages."),
  reconcile_choice: z
    .enum(["Keep", "Bypass", "Delete"])
    .default("Keep")
    .describe("For reconcile apply: keep, bypass, or request native approval to delete."),
  plan_id: z
    .string()
    .min(16)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional()
    .describe("Opaque plan id from the immediately preceding reconciliation dry-run."),
  confirmation_timeout_ms: z.coerce
    .number()
    .int()
    .min(5_000)
    .max(120_000)
    .default(30_000)
    .describe("Bounded native Delete/Bypass/Keep broker wait."),
});
type ManagePackagesArgs = z.infer<typeof managePackagesSchema>;

function packageStorage(args: ManagePackagesArgs) {
  return resolvePackageStorage({
    scope: args.scope,
    projectDir: args.project_dir,
    rootOverride: args.packages_root,
  });
}

function requirePackageId(args: ManagePackagesArgs): string | undefined {
  return args.package_id?.trim() || undefined;
}

// Best-effort live TD build detection so version-gated packages (e.g. RayTK, which needs the
// 2025.30770 experimental build) warn against the running build. Returns undefined when the
// bridge is unreachable, which the doctor treats as an offline gate warning.
// Return `build` (the YYYY.NNNNN number the gate compares against, e.g. "2025.32820") only. The
// `td_version` field is the product series (e.g. "099"), not a build number, so it must NOT drive
// the numeric gate — when `build` is absent the doctor treats it as the offline/unknown case.
async function detectLiveBuild(ctx: ToolContext): Promise<string | undefined> {
  try {
    const info = await ctx.client.getInfo();
    return info.build ?? undefined;
  } catch {
    return undefined;
  }
}

function reconcileRecord(
  args: ManagePackagesArgs,
  packageId: string,
): { record?: PackageReconcileRecord; paths: ReturnType<typeof createPackagePaths> } {
  const storage = packageStorage(args);
  const paths = createPackagePaths({ rootDir: storage.root });
  const found = readPackageState(paths).packages.find((item) => item.id === packageId);
  if (!found) return { paths };
  return {
    paths,
    record: {
      id: found.id,
      sourceUrl: found.sourceUrl,
      ref: found.ref,
      scope: args.scope,
      ...(found.bridgeTargetPath ? { bridgeTargetPath: found.bridgeTargetPath } : {}),
      ...(found.stagedPath ? { stagedPath: found.stagedPath } : {}),
    },
  };
}

function sameRecord(left: PackageReconcileRecord, right: PackageReconcileRecord): boolean {
  return (
    left.id === right.id &&
    left.sourceUrl === right.sourceUrl &&
    left.ref === right.ref &&
    left.scope === right.scope &&
    left.bridgeTargetPath === right.bridgeTargetPath &&
    left.stagedPath === right.stagedPath
  );
}

function safeStagedPath(root: string, stagedPath: string): string {
  const candidate = resolve(stagedPath);
  const rel = relative(resolve(root), candidate);
  if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
    throw new Error("Recorded staged path is outside the package install root.");
  }
  if (lstatSync(candidate).isSymbolicLink()) {
    throw new Error("Refusing to quarantine a symlinked package staging path.");
  }
  return candidate;
}

function reconcileDependencies(
  ctx: ToolContext,
  args: ManagePackagesArgs,
  paths: ReturnType<typeof createPackagePaths>,
): ReconcilePackageNamespaceDependencies {
  const quarantines = new Map<string, { original: string; quarantined: string }>();
  return {
    bridge: {
      check: (input) => ctx.client.checkPackageNamespace(input),
      apply: (input) => ctx.client.applyPackageNamespace(input),
    },
    records: {
      read: async (packageId, scope) => {
        if (scope !== args.scope) return undefined;
        return reconcileRecord(args, packageId).record;
      },
      remove: async (expected) => {
        const current = reconcileRecord(args, expected.id).record;
        if (!current || !sameRecord(current, expected)) {
          throw new Error("Installed package record changed before commit.");
        }
        const state = readPackageState(paths);
        writePackageState(paths, {
          version: 1,
          packages: state.packages.filter((item) => item.id !== expected.id),
        });
      },
      exists: async (packageId, scope) =>
        scope === args.scope && reconcileRecord(args, packageId).record !== undefined,
    },
    staging: {
      quarantine: async (record): Promise<PackageQuarantineHandle> => {
        const token = randomUUID().replaceAll("-", "_");
        if (!record.stagedPath || !existsSync(record.stagedPath)) {
          return { token, prepared: false };
        }
        const original = safeStagedPath(paths.installRoot, record.stagedPath);
        const quarantined = `${original}.tdmcp-quarantine-${token}`;
        if (existsSync(quarantined)) throw new Error("Package quarantine collision.");
        renameSync(original, quarantined);
        quarantines.set(token, { original, quarantined });
        return { token, prepared: true };
      },
      restore: async (handle) => {
        const entry = quarantines.get(handle.token);
        if (!entry || !existsSync(entry.quarantined) || existsSync(entry.original)) {
          throw new Error("Package quarantine cannot be restored safely.");
        }
        renameSync(entry.quarantined, entry.original);
        quarantines.delete(handle.token);
      },
      discard: async (handle) => {
        const entry = quarantines.get(handle.token);
        if (!entry) throw new Error("Unknown package quarantine token.");
        rmSync(entry.quarantined, { recursive: true, force: false });
        quarantines.delete(handle.token);
      },
    },
    journal: {
      write: async (entry) => {
        mkdirSync(paths.root, { recursive: true });
        appendFileSync(
          join(paths.root, "reconcile-journal.jsonl"),
          `${JSON.stringify({ ...entry, at: new Date().toISOString() })}\n`,
          { encoding: "utf8", mode: 0o600 },
        );
      },
    },
  };
}

function checkInput(record: PackageReconcileRecord, args: ManagePackagesArgs) {
  return {
    project_path: args.project_path,
    package_id: record.id,
    source_url: record.sourceUrl,
    recorded_ref: record.ref,
    ...(record.bridgeTargetPath ? { recorded_target_path: record.bridgeTargetPath } : {}),
    scope: record.scope,
    intent: "prune" as const,
  };
}

function reconcileInputError(args: ManagePackagesArgs): string | undefined {
  if (!args.dry_run && !args.plan_id) {
    return "A `plan_id` from a reconciliation dry-run is required to apply.";
  }
  if (args.dry_run && args.plan_id) {
    return "A reconciliation dry-run does not accept `plan_id`.";
  }
  return undefined;
}

type NativePackageDecision = {
  interactionId?: string;
  earlyResult?: CallToolResult;
};

async function prepareNativePackageDecision(
  ctx: ToolContext,
  args: ManagePackagesArgs,
  record: PackageReconcileRecord,
  packageId: string,
): Promise<NativePackageDecision> {
  if (args.dry_run || args.reconcile_choice !== "Delete" || ctx.yolo) return {};

  const currentPlan = await ctx.client.checkPackageNamespace(checkInput(record, args));
  if (currentPlan.plan_id !== args.plan_id || !currentPlan.resolved_target_path) {
    return {
      earlyResult: errorResult("The reconciliation plan is stale or has no proved-owned target."),
    };
  }
  const decision = await ctx.client.requestDeleteDecision(
    currentPlan.resolved_target_path,
    args.confirmation_timeout_ms,
  );
  if (decision.choice !== "Keep") return { interactionId: decision.request_id };

  return {
    earlyResult: structuredResult(`Kept ${packageId}; no TD, staging, or registry state changed.`, {
      status: "kept",
      packageId,
      planId: args.plan_id,
      decision,
      storage: {
        quarantined: false,
        restored: false,
        recordRemoved: false,
        quarantineDiscarded: false,
      },
    }),
  };
}

async function reconcilePackages(ctx: ToolContext, args: ManagePackagesArgs, packageId: string) {
  const { record, paths } = reconcileRecord(args, packageId);
  if (!record) return errorResult(`${packageId} is not recorded as installed.`);
  const inputIssue = reconcileInputError(args);
  if (inputIssue) return errorResult(inputIssue);
  const decision = await prepareNativePackageDecision(ctx, args, record, packageId);
  if (decision.earlyResult) return decision.earlyResult;

  const report = await reconcilePackageNamespace(
    {
      packageId,
      projectPath: args.project_path,
      scope: args.scope,
      intent: "prune",
      dryRun: args.dry_run,
      choice: args.reconcile_choice,
      ...(args.plan_id ? { planId: args.plan_id } : {}),
      confirmationPolicy: ctx.yolo ? "yolo" : "native",
      ...(decision.interactionId ? { interactionId: decision.interactionId } : {}),
    },
    reconcileDependencies(ctx, args, paths),
  );
  const summary =
    report.status === "planned"
      ? `Planned reconciliation for ${packageId}; no state changed.`
      : `Package reconciliation for ${packageId}: ${report.status}.`;
  return structuredResult(summary, { report, storage: packageStorage(args) });
}

type PackageActionHandler = (
  ctx: ToolContext,
  args: ManagePackagesArgs,
) => CallToolResult | Promise<CallToolResult>;

const requireActionPackageId = (
  args: ManagePackagesArgs,
  action: string,
): string | CallToolResult =>
  requirePackageId(args) ?? errorResult(`A \`package_id\` is required for package ${action}.`);

const handleSearch: PackageActionHandler = (_ctx, args) => {
  const packages = searchPackages(args.query ?? "");
  return structuredResult(`Found ${packages.length} package search result(s).`, { packages });
};

const handleList: PackageActionHandler = (_ctx, args) => {
  const storage = packageStorage(args);
  const paths = createPackagePaths({ rootDir: storage.root });
  const available = listPackages();
  const installed = args.installed ? readPackageState(paths).packages : [];
  return structuredResult(
    `Listed ${available.length} available package(s) and ${installed.length} installed package(s).`,
    { available, installed, storage },
  );
};

const handleInfo: PackageActionHandler = (_ctx, args) => {
  const id = requireActionPackageId(args, "info");
  if (typeof id !== "string") return id;
  const pkg = resolvePackage(id);
  if (!pkg) return errorResult(`Unknown package: ${id}`);
  return structuredResult(`${pkg.displayName}: ${pkg.supportLevel}.`, { package: pkg });
};

const handleDoctor: PackageActionHandler = async (ctx, args) => {
  const id = requireActionPackageId(args, "doctor");
  if (typeof id !== "string") return id;
  const report = doctorPackage(id, { liveBuild: await detectLiveBuild(ctx) });
  return structuredResult(`Package doctor: ${report.status}.`, { report });
};

const handleInstall: PackageActionHandler = async (ctx, args) => {
  const id = requireActionPackageId(args, "install");
  if (typeof id !== "string") return id;
  const storage = packageStorage(args);
  const report = await installPackage(id, {
    rootDir: storage.root,
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
  return structuredResult(`${report.package.displayName}: ${report.status}.`, { report, storage });
};

const handleUninstall: PackageActionHandler = async (ctx, args) => {
  const id = requireActionPackageId(args, "uninstall");
  if (typeof id !== "string") return id;
  const storage = packageStorage(args);
  const paths = createPackagePaths({ rootDir: storage.root });
  const recordedId = resolvePackage(id)?.id ?? id;
  const installed = readPackageState(paths).packages.find((item) => item.id === recordedId);
  if (installed?.bridgeTargetPath) {
    return reconcilePackages(
      ctx,
      { ...args, dry_run: true, reconcile_choice: "Keep", plan_id: undefined },
      recordedId,
    );
  }
  const report = await uninstallPackage(id, { rootDir: storage.root, yes: args.yes });
  return structuredResult(`${report.packageId}: ${report.removed ? "removed" : "not installed"}.`, {
    report,
    storage,
  });
};

const handleReconcile: PackageActionHandler = async (ctx, args) => {
  const id = requireActionPackageId(args, "reconciliation");
  return typeof id === "string" ? reconcilePackages(ctx, args, id) : id;
};

const handlePath: PackageActionHandler = (_ctx, args) => {
  const storage = packageStorage(args);
  const paths = createPackagePaths({ rootDir: storage.root });
  return structuredResult(`Package root: ${paths.root}`, { paths, storage });
};

const PACKAGE_ACTIONS: Record<ManagePackagesArgs["action"], PackageActionHandler> = {
  search: handleSearch,
  list: handleList,
  info: handleInfo,
  doctor: handleDoctor,
  install: handleInstall,
  uninstall: handleUninstall,
  reconcile: handleReconcile,
  path: handlePath,
};

export async function managePackagesImpl(
  ctx: ToolContext,
  args: ManagePackagesArgs,
): Promise<CallToolResult> {
  try {
    return await PACKAGE_ACTIONS[args.action](ctx, args);
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
        "Search, list, inspect, doctor, install, reconcile, and uninstall manifest-driven TouchDesigner community packages at explicit user or project scope. Reconciliation is dry-run-first, proves marker ownership, and uses Delete/Bypass/Keep consent before pruning a live package. A legacy uninstall with a live TD target now returns the safe reconciliation plan instead of deleting local state first. This tool never runs third-party scripts, pip installs, model downloads, or external app setup.",
      inputSchema: managePackagesSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    (args) => managePackagesImpl(ctx, args),
  );
};
