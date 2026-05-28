// Builds the Claude Desktop Extension bundle (`tdmcp.mcpb`).
//
// An .mcpb (MCP Bundle) is a zip archive whose root contains `manifest.json`
// plus the server's runtime files. This script prefers the official packer when
// it is available, and otherwise falls back to assembling the zip itself from
// the verified file list.
//
// The official packer was renamed from `@anthropic-ai/dxt` (CLI `dxt`, format
// `.dxt`) to `@anthropic-ai/mcpb` (CLI `mcpb`, format `.mcpb`); both expose
// `pack <dir> <output>`. We try the current `mcpb` package first, then the
// legacy `dxt` package, then zip. NOTE: the legacy `dxt` CLI predates spec 0.3
// and rejects the modern `manifest_version` key (it still requires
// `dxt_version`), so on machines that only have the legacy package the
// official-packer path is expected to fail and the zip fallback kicks in — the
// resulting bundle is still valid. (Legacy `.dxt` bundles still install in
// Claude Desktop; `.mcpb` is the current format.)
//
// Run AFTER `npm run build` (the bundle needs a populated `dist/`).
//
// Usage:
//   node scripts/build-dxt.mjs
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(root, "dxt", "manifest.json");
const outFile = join(root, "tdmcp.mcpb");

/** Files/dirs to include at the root of the bundle (source -> archive path). */
// node_modules is intentionally NOT here — it's staged production-only by
// stageNodeModules() so the bundle stays small (no dev tooling / build-only deps).
const INCLUDE = [
  // manifest.json MUST sit at the archive root.
  [manifestPath, "manifest.json"],
  [join(root, "dist"), "dist"],
  [join(root, "recipes"), "recipes"],
  [join(root, "td"), "td"],
  [join(root, "README.md"), "README.md"],
  [join(root, "LICENSE"), "LICENSE"],
  [join(root, "package.json"), "package.json"],
];

function log(msg) {
  process.stdout.write(`[build-dxt] ${msg}\n`);
}

function fail(msg) {
  process.stderr.write(`[build-dxt] ERROR: ${msg}\n`);
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

// Official packer package names, in preference order. `mcpb` is the current
// name; `dxt` is the deprecated predecessor. Both expose `<cli> pack <dir> <out>`.
const OFFICIAL_PACKERS = [
  { pkg: "@anthropic-ai/mcpb", cli: "mcpb" },
  { pkg: "@anthropic-ai/dxt", cli: "dxt" },
];

/** Stage the verified file list into `stageDir` (archive root holds manifest.json). */
function stageFiles(stageDir) {
  for (const [src, dest] of INCLUDE) {
    if (!existsSync(src)) continue;
    const target = join(stageDir, dest);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(src, target, { recursive: true });
  }
}

/**
 * Stage a PRODUCTION-only node_modules into the bundle so the .mcpb stays small —
 * no dev tooling (TypeScript, Biome, Vitest) and no build-only data
 * (`@bottobot/td-mcp`; the knowledge base is already baked into `dist/`). Installs
 * from the lockfile into the staging dir; if that fails (e.g. offline with a cold
 * cache) it falls back to copying the repo's node_modules so the build still
 * produces a working — if larger — bundle.
 */
function stageNodeModules(stageDir) {
  cpSync(join(root, "package.json"), join(stageDir, "package.json"));
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
  if (res.status === 0 && existsSync(join(stageDir, "node_modules"))) return;
  log("prod-only install failed — copying the repo node_modules as a fallback (larger bundle).");
  cpSync(join(root, "node_modules"), join(stageDir, "node_modules"), { recursive: true });
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

    const stageDir = mkdtempSync(join(tmpdir(), "tdmcp-dxt-"));
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
  const stageDir = mkdtempSync(join(tmpdir(), "tdmcp-dxt-"));
  try {
    for (const [src, dest] of INCLUDE) {
      if (!existsSync(src)) {
        log(`skip (missing): ${dest}`);
        continue;
      }
      const target = join(stageDir, dest);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(src, target, { recursive: true });
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
