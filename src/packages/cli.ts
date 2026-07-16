import { parseArgs } from "node:util";
import { buildToolContext } from "../server/context.js";
import { loadConfig } from "../utils/config.js";
import { silentLogger } from "../utils/logger.js";
import { doctorAllPackages, doctorPackage } from "./doctor.js";
import { installPackage, uninstallPackage } from "./installer.js";
import { createPackagePaths } from "./paths.js";
import { getDeferredPackage, listPackages, resolvePackage, searchPackages } from "./registry.js";
import { type PackageStorageResolution, resolvePackageStorage } from "./scopes.js";
import { readPackageState } from "./state.js";
import type { PackageBridge, PackageCliResult, PackageManagerOptions } from "./types.js";

const PACKAGE_COMMANDS = new Set([
  "search",
  "list",
  "info",
  "install",
  "uninstall",
  "doctor",
  "packages",
]);

export interface RunPackageCliOptions extends PackageManagerOptions {
  bridge?: PackageBridge;
  cwd?: string;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}

export function isPackageCommand(command: string | undefined): boolean {
  return Boolean(command && PACKAGE_COMMANDS.has(command));
}

function json(data: unknown): string {
  return `${JSON.stringify(data, null, 2)}\n`;
}

function textList(rows: string[]): string {
  return `${rows.join("\n")}\n`;
}

function parse(argv: string[], options: NonNullable<Parameters<typeof parseArgs>[0]>["options"]) {
  return parseArgs({ args: argv, allowPositionals: true, options });
}

type ParsedValues = Record<string, string | boolean | undefined>;

function defaultBridge(): PackageBridge {
  const config = loadConfig();
  const ctx = buildToolContext(config, { logger: silentLogger });
  return {
    mode: "client",
    getInfo: () => ctx.client.getInfo(),
    executePythonScript: (script, returnOutput) =>
      ctx.client.executePythonScript(script, returnOutput),
    getNodeErrors: (path) => ctx.client.getNodeErrors(path),
  };
}

function ok(stdout: string): PackageCliResult {
  return { stdout, stderr: "", code: 0 };
}

function fail(message: string, code = 2): PackageCliResult {
  return { stdout: "", stderr: `${message}\n`, code };
}

function legacyVersionPin(version: string | boolean | undefined): string | undefined {
  if (typeof version !== "string") return undefined;
  return version.toLowerCase() === "latest" ? undefined : version;
}

function usage(): string {
  return textList([
    "tdmcp packages — community library package manager",
    "",
    "Commands:",
    "  tdmcp search [query] [--json]",
    "  tdmcp list [--installed] [--available] [--json]",
    "  tdmcp info <lib> [--json]",
    "  tdmcp install <lib> [--project /project1] [--name customName] [--dry-run] [--pin <ref>] [--json] [--yes] [--allow-python-deps] [--allow-external]",
    "  tdmcp uninstall <lib> [--project /project1] [--json] [--yes]",
    "  tdmcp packages doctor [<lib>] [--json]",
    "  tdmcp packages path [--scope user|project] [--project-dir <dir>] [--json]",
  ]);
}

function packageScope(value: string | boolean | undefined): "project" | "user" {
  if (value === undefined || value === "user") return "user";
  if (value === "project") return "project";
  throw new Error("--scope must be user or project.");
}

function stringValue(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function resolveCliStorage(
  values: ParsedValues,
  opts: RunPackageCliOptions,
): PackageStorageResolution {
  return resolvePackageStorage({
    scope: packageScope(values.scope),
    projectDir: stringValue(values["project-dir"]),
    rootOverride: stringValue(values["packages-root"]) ?? stringValue(values.dir) ?? opts.rootDir,
    cwd: opts.cwd,
    homeDir: opts.homeDir,
    env: opts.env,
  });
}

const STORAGE_OPTIONS = {
  scope: { type: "string" as const },
  "project-dir": { type: "string" as const },
  "packages-root": { type: "string" as const },
};

function packageDoctorResult(id: string | undefined, asJson: boolean): PackageCliResult {
  const report = id ? doctorPackage(id) : doctorAllPackages();
  if (asJson) return ok(json(report));
  return ok(
    textList([
      report.package
        ? `${report.package.displayName}: ${report.status}`
        : report.deferred
          ? `${report.deferred.displayName}: deferred`
          : `Package doctor: ${report.status}`,
      ...report.checks.map((check) => `[${check.status}] ${check.message}`),
      ...report.nextSteps.map((step) => `Next: ${step}`),
    ]),
  );
}

export function isKnownPackageDoctorTarget(id: string | undefined): boolean {
  return Boolean(id && (resolvePackage(id) || getDeferredPackage(id)));
}

function packageSummary(pkg: ReturnType<typeof listPackages>[number]): string {
  return `${pkg.id.padEnd(28)} ${pkg.supportLevel.padEnd(11)} ${pkg.description}`;
}

export async function runPackageCli(
  argv: string[],
  opts: RunPackageCliOptions = {},
): Promise<PackageCliResult> {
  const command = argv[0];
  if (!isPackageCommand(command)) return fail(usage());
  if (argv.includes("--help") || argv.includes("-h")) return ok(usage());
  try {
    if (command === "search") {
      const parsed = parse(argv.slice(1), { json: { type: "boolean", default: false } });
      const values = parsed.values as ParsedValues;
      const query = parsed.positionals.join(" ");
      const packages = searchPackages(query);
      if (values.json) return ok(json(packages));
      return ok(textList(packages.map(packageSummary)));
    }

    if (command === "list") {
      const parsed = parse(argv.slice(1), {
        json: { type: "boolean", default: false },
        installed: { type: "boolean", default: false },
        available: { type: "boolean", default: false },
        ...STORAGE_OPTIONS,
      });
      const values = parsed.values as ParsedValues;
      const storage = resolveCliStorage(values, opts);
      const paths = createPackagePaths({ rootDir: storage.root });
      const available = listPackages({
        available: !(values.installed && !values.available),
      });
      const installed = values.installed ? readPackageState(paths).packages : [];
      const doc = { available, installed, storage };
      if (values.json) return ok(json(doc));
      const rows = [
        ...(available.length > 0 ? ["Available:", ...available.map(packageSummary)] : []),
        ...(installed.length > 0
          ? ["", "Installed:", ...installed.map((pkg) => `${pkg.id} ${pkg.status}`)]
          : []),
      ];
      return ok(textList(rows.length > 0 ? rows : ["No packages found."]));
    }

    if (command === "info") {
      const parsed = parse(argv.slice(1), { json: { type: "boolean", default: false } });
      const values = parsed.values as ParsedValues;
      const id = parsed.positionals[0];
      if (!id) return fail("Usage: tdmcp info <lib> [--json]");
      const pkg = resolvePackage(id);
      if (!pkg) return fail(`Unknown package: ${id}`, 1);
      if (values.json) return ok(json(pkg));
      return ok(
        textList([
          `${pkg.displayName} (${pkg.id})`,
          pkg.description,
          `Source: ${pkg.source.url}`,
          `Support: ${pkg.supportLevel}`,
          `Type: ${pkg.packageType}`,
        ]),
      );
    }

    if (command === "install") {
      const parsed = parse(argv.slice(1), {
        json: { type: "boolean", default: false },
        "dry-run": { type: "boolean", default: false },
        project: { type: "string" },
        name: { type: "string" },
        pin: { type: "string" },
        version: { type: "string" },
        asset: { type: "string" },
        dir: { type: "string" },
        "packages-root": { type: "string" },
        yes: { type: "boolean", default: false },
        "allow-python-deps": { type: "boolean", default: false },
        "allow-external": { type: "boolean", default: false },
        scope: { type: "string" },
        "project-dir": { type: "string" },
      });
      const values = parsed.values as ParsedValues;
      const id = parsed.positionals[0];
      if (!id) return fail("Usage: tdmcp install <lib> [--dry-run] [--json]");
      const storage = resolveCliStorage(values, opts);
      const report = await installPackage(id, {
        ...opts,
        rootDir: storage.root,
        dryRun: Boolean(values["dry-run"]),
        projectPath: typeof values.project === "string" ? values.project : undefined,
        name: typeof values.name === "string" ? values.name : undefined,
        pin: typeof values.pin === "string" ? values.pin : legacyVersionPin(values.version),
        assetFilter: typeof values.asset === "string" ? values.asset : undefined,
        yes: Boolean(values.yes),
        allowPythonDeps: Boolean(values["allow-python-deps"]),
        allowExternal: Boolean(values["allow-external"]),
        bridge: values["dry-run"] ? { mode: "offline" } : (opts.bridge ?? defaultBridge()),
      });
      if (values.json) return ok(json({ ...report, storage }));
      return ok(
        textList(
          [
            `${report.package.displayName}: ${report.status}`,
            `Storage: ${storage.scope} (${storage.root})`,
            report.stagedPath ? `Staged: ${report.stagedPath}` : "",
            ...report.warnings.map((warning) => `Warning: ${warning}`),
            ...report.nextSteps.map((step) => `Next: ${step}`),
          ].filter(Boolean),
        ),
      );
    }

    if (command === "uninstall") {
      const parsed = parse(argv.slice(1), {
        json: { type: "boolean", default: false },
        project: { type: "string" },
        yes: { type: "boolean", default: false },
        ...STORAGE_OPTIONS,
      });
      const values = parsed.values as ParsedValues;
      const id = parsed.positionals[0];
      if (!id) return fail("Usage: tdmcp uninstall <lib> [--json] [--yes]");
      const storage = resolveCliStorage(values, opts);
      const report = await uninstallPackage(id, {
        ...opts,
        rootDir: storage.root,
        yes: Boolean(values.yes),
      });
      if (values.json) return ok(json({ ...report, storage }));
      return ok(
        textList([
          `${report.packageId}: ${report.removed ? "removed" : "not installed"}`,
          `Storage: ${storage.scope} (${storage.root})`,
          ...report.warnings.map((warning) => `Warning: ${warning}`),
          ...report.nextSteps.map((step) => `Next: ${step}`),
        ]),
      );
    }

    if (command === "doctor") {
      const parsed = parse(argv.slice(1), { json: { type: "boolean", default: false } });
      const values = parsed.values as ParsedValues;
      return packageDoctorResult(parsed.positionals[0], Boolean(values.json));
    }

    if (command === "packages") {
      const parsed = parse(argv.slice(1), {
        json: { type: "boolean", default: false },
        ...STORAGE_OPTIONS,
      });
      const values = parsed.values as ParsedValues;
      if (parsed.positionals[0] === "doctor") {
        return packageDoctorResult(parsed.positionals[1], Boolean(values.json));
      }
      if (parsed.positionals[0] !== "path") {
        return fail(
          "Usage: tdmcp packages path [--json] or tdmcp packages doctor [package] [--json]",
        );
      }
      const storage = resolveCliStorage(values, opts);
      const paths = createPackagePaths({ rootDir: storage.root });
      if (values.json) return ok(json({ ...paths, storage }));
      return ok(textList([paths.root]));
    }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err), 1);
  }
  return fail(usage());
}
