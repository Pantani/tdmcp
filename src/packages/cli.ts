import { parseArgs } from "node:util";
import { buildToolContext } from "../server/context.js";
import { loadConfig } from "../utils/config.js";
import { silentLogger } from "../utils/logger.js";
import { doctorAllPackages, doctorPackage } from "./doctor.js";
import { installPackage, uninstallPackage } from "./installer.js";
import { createPackagePaths } from "./paths.js";
import { listPackages, resolvePackage, searchPackages } from "./registry.js";
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
    "  tdmcp doctor [<lib>] [--json]",
    "  tdmcp packages path [--json]",
  ]);
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
      });
      const values = parsed.values as ParsedValues;
      const paths = createPackagePaths({ rootDir: opts.rootDir });
      const available = listPackages({
        available: !(values.installed && !values.available),
      });
      const installed = values.installed ? readPackageState(paths).packages : [];
      const doc = { available, installed };
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
      });
      const values = parsed.values as ParsedValues;
      const id = parsed.positionals[0];
      if (!id) return fail("Usage: tdmcp install <lib> [--dry-run] [--json]");
      const rootDir =
        typeof values["packages-root"] === "string"
          ? values["packages-root"]
          : typeof values.dir === "string"
            ? values.dir
            : opts.rootDir;
      const report = await installPackage(id, {
        ...opts,
        rootDir,
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
      if (values.json) return ok(json(report));
      return ok(
        textList(
          [
            `${report.package.displayName}: ${report.status}`,
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
      });
      const values = parsed.values as ParsedValues;
      const id = parsed.positionals[0];
      if (!id) return fail("Usage: tdmcp uninstall <lib> [--json] [--yes]");
      const report = await uninstallPackage(id, { ...opts, yes: Boolean(values.yes) });
      if (values.json) return ok(json(report));
      return ok(
        textList([
          `${report.packageId}: ${report.removed ? "removed" : "not installed"}`,
          ...report.warnings.map((warning) => `Warning: ${warning}`),
          ...report.nextSteps.map((step) => `Next: ${step}`),
        ]),
      );
    }

    if (command === "doctor") {
      const parsed = parse(argv.slice(1), { json: { type: "boolean", default: false } });
      const values = parsed.values as ParsedValues;
      const id = parsed.positionals[0];
      const report = id ? doctorPackage(id) : doctorAllPackages();
      if (values.json) return ok(json(report));
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

    if (command === "packages") {
      const parsed = parse(argv.slice(1), { json: { type: "boolean", default: false } });
      const values = parsed.values as ParsedValues;
      if (parsed.positionals[0] !== "path") return fail("Usage: tdmcp packages path [--json]");
      const paths = createPackagePaths({ rootDir: opts.rootDir });
      if (values.json) return ok(json(paths));
      return ok(textList([paths.root]));
    }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err), 1);
  }
  return fail(usage());
}
