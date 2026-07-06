// Builds the Claude Desktop Extension bundle (`tdmcp.mcpb`).
//
// An .mcpb (MCP Bundle) is a zip archive whose root contains `manifest.json`
// plus the server's runtime files. This script prefers the official packer when
// it is available, and otherwise falls back to assembling the zip itself from
// the verified file list.
//
// The official packer was renamed from `@anthropic-ai/dxt` to
// `@anthropic-ai/mcpb`; both expose `pack <dir> <output>`. We try a pinned
// `@anthropic-ai/mcpb` first, then the legacy `@anthropic-ai/dxt`, then zip.
// NOTE: the legacy packer predates manifest spec 0.3 and rejects the modern
// `manifest_version` key (it still requires the old `dxt_version`), so on
// machines that only have the legacy package the official-packer path is
// expected to fail and the zip fallback kicks in — the resulting bundle is
// still valid and installs in Claude Desktop.
//
// Run AFTER `npm run build` (the bundle needs a populated `dist/`).
//
// Usage:
//   node scripts/build-mcpb.mjs
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(root, "mcpb", "manifest.json");
const outFile = join(root, "tdmcp.mcpb");

/** Files/dirs to include at the root of the bundle (source -> archive path). */
// node_modules is intentionally NOT here — it's staged production-only by
// stageNodeModules() so the bundle stays small (no dev tooling / build-only deps).
const INCLUDE = [
  // manifest.json MUST sit at the archive root.
  [manifestPath, "manifest.json"],
  // icon.png (referenced by manifest.icon) must sit at the archive root too.
  [join(root, "mcpb", "icon.png"), "icon.png"],
  [join(root, "dist"), "dist"],
  [join(root, "recipes"), "recipes"],
  [join(root, "td"), "td"],
  [join(root, "README.md"), "README.md"],
  [join(root, "LICENSE"), "LICENSE"],
  [join(root, "package.json"), "package.json"],
  [join(root, "safeskill.manifest.json"), "safeskill.manifest.json"],
];

function shouldStage(src) {
  const rel = relative(root, src).split(/[\\/]/).join("/");
  if (rel === "td/tests" || rel.startsWith("td/tests/")) return false;
  if (rel.includes("__pycache__")) return false;
  return !rel.endsWith(".pyc");
}

function log(msg) {
  process.stdout.write(`[build-mcpb] ${msg}\n`);
}

function fail(msg) {
  process.stderr.write(`[build-mcpb] ERROR: ${msg}\n`);
  process.exit(1);
}

function preflight() {
  if (!existsSync(manifestPath)) {
    fail(`missing manifest: ${manifestPath}`);
  }
  if (!existsSync(join(root, "dist", "index.js"))) {
    fail("dist/index.js not found. Run `npm run build` before building the .mcpb bundle.");
  }
  if (!existsSync(join(root, "package-lock.json"))) {
    fail("package-lock.json not found — it is needed to install production deps into the bundle.");
  }
}

// Official packer package names, in preference order. These are version-pinned
// so release builds do not resolve mutable npm latest at pack time. `mcpb` is
// the current name; `@anthropic-ai/dxt` is the deprecated predecessor. Both expose
// `<cli> pack <dir> <out>`.
const OFFICIAL_PACKERS = [{ pkg: "@anthropic-ai/mcpb@2.1.2" }, { pkg: "@anthropic-ai/dxt@0.2.6" }];

/** Stage the verified file list into `stageDir` (archive root holds manifest.json). */
function stageFiles(stageDir) {
  for (const [src, dest] of INCLUDE) {
    if (!existsSync(src)) continue;
    const target = join(stageDir, dest);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(src, target, { recursive: true, filter: shouldStage });
  }
}

function productionInstallManifest() {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  return {
    name: pkg.name,
    version: pkg.version,
    type: pkg.type,
    engines: pkg.engines,
    dependencies: pkg.dependencies,
    overrides: pkg.overrides,
  };
}

/**
 * Stage a PRODUCTION-only node_modules into the bundle so the .mcpb stays small —
 * no dev tooling (TypeScript, Biome, Vitest) and no build-only data
 * (`@bottobot/td-mcp`; the knowledge base is already baked into `dist/`).
 * Installs from the lockfile into the staging dir. If that fails, fail closed:
 * copying the repo workspace node_modules would mix dev/build tooling into a
 * release artifact and bypass the production-only dependency contract.
 */
function stageNodeModules(stageDir) {
  const stagedPackageJson = join(stageDir, "package.json");
  const fullPackageJson = readFileSync(join(root, "package.json"), "utf8");
  writeFileSync(stagedPackageJson, `${JSON.stringify(productionInstallManifest(), null, 2)}\n`);
  cpSync(join(root, "package-lock.json"), join(stageDir, "package-lock.json"));
  log("installing production dependencies into the bundle (npm ci --omit=dev)…");
  const res = spawnSync(
    "npm",
    ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
    {
      cwd: stageDir,
      stdio: "inherit",
    },
  );
  writeFileSync(stagedPackageJson, fullPackageJson);
  if (res.status === 0 && existsSync(join(stageDir, "node_modules"))) return;
  const reason =
    res.signal != null ? `signal ${res.signal}` : `exit status ${String(res.status ?? "unknown")}`;
  fail(
    "prod-only install failed while staging bundle dependencies " +
      `(${reason}); refusing to copy the workspace node_modules. ` +
      "Restore npm registry/cache access, then rerun `npm run build:mcpb`.",
  );
}

/** Try the official packer(s). Returns true if one ran and succeeded. */
function tryOfficialPacker() {
  // `<cli> pack <dir> <output>` packs a directory whose root holds manifest.json.
  // We stage the verified file list into a temp dir, then point the packer at it.
  for (const { pkg } of OFFICIAL_PACKERS) {
    log(`attempting official packer: npx ${pkg} pack …`);
    const probe = spawnSync("npx", ["--yes", pkg, "--version"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (probe.status !== 0) {
      log(`${pkg} not available — trying next packer.`);
      continue;
    }

    const stageDir = mkdtempSync(join(tmpdir(), "tdmcp-mcpb-"));
    try {
      stageFiles(stageDir);
      stageNodeModules(stageDir);
      const res = spawnSync("npx", ["--yes", pkg, "pack", stageDir, outFile], {
        cwd: root,
        encoding: "utf8",
        stdio: "inherit",
      });
      if (res.status === 0) {
        log(`official packer (${pkg}) produced ${outFile}`);
        return true;
      }
      log(`${pkg} failed to pack — trying next packer.`);
    } finally {
      rmSync(stageDir, { recursive: true, force: true });
    }
  }
  log("no official packer succeeded — falling back to built-in zip.");
  return false;
}

/** Fallback: assemble the .mcpb with the system `zip` tool. */
function zipFallback() {
  const hasZip = spawnSync("zip", ["-v"], { stdio: "ignore" }).status === 0;
  if (!hasZip) {
    fail(
      "neither the official packer (`npx @anthropic-ai/mcpb`) nor a system `zip` is available.\n" +
        "  Install one of them, e.g.:\n" +
        "    npm i -g @anthropic-ai/mcpb   # then re-run this script\n" +
        "    # or install a `zip` CLI (brew install zip / apt-get install zip)",
    );
  }

  // Stage files so the archive has manifest.json at its root.
  const stageDir = mkdtempSync(join(tmpdir(), "tdmcp-mcpb-"));
  try {
    for (const [src, dest] of INCLUDE) {
      if (!existsSync(src)) {
        log(`skip (missing): ${dest}`);
        continue;
      }
      const target = join(stageDir, dest);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(src, target, { recursive: true, filter: shouldStage });
      log(`staged ${dest}`);
    }
    stageNodeModules(stageDir);
    rmSync(outFile, { force: true });
    const res = spawnSync("zip", ["-r", "-q", "-X", outFile, "."], {
      cwd: stageDir,
      stdio: "inherit",
    });
    if (res.status !== 0) {
      fail("`zip` failed to create the bundle.");
    }
    log(`built ${outFile} (built-in zip fallback)`);
  } finally {
    rmSync(stageDir, { recursive: true, force: true });
  }
}

function main() {
  preflight();
  rmSync(outFile, { force: true });
  if (!tryOfficialPacker()) {
    zipFallback();
  }
  log("");
  log("Done. To install in Claude Desktop:");
  log("  1. Open Claude Desktop → Settings → Extensions.");
  log(`  2. Drag in (or “Install from file”) the bundle: ${outFile}`);
  log("  3. Set the TouchDesigner host/port if they differ from the defaults");
  log("     (127.0.0.1 : 9980), then enable the extension.");
  log("");
  log("Note: the Desktop extension runs over stdio (Claude Desktop spawns it).");
  log("For containers use the Docker/HTTP path instead — see docs/DEPLOYMENT.md.");
}

main();
