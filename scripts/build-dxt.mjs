// Builds the Claude Desktop Extension bundle (`tdmcp.dxt`).
//
// A .dxt is a zip archive whose root contains `manifest.json` plus the server's
// runtime files. This script prefers the official packer
// (`npx @anthropic-ai/dxt pack`) when it is available, and otherwise falls back
// to assembling the zip itself from the verified file list.
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
const outFile = join(root, "tdmcp.dxt");

/** Files/dirs to include at the root of the bundle (source -> archive path). */
const INCLUDE = [
  // manifest.json MUST sit at the archive root.
  [manifestPath, "manifest.json"],
  [join(root, "dist"), "dist"],
  [join(root, "node_modules"), "node_modules"],
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
    fail("dist/index.js not found. Run `npm run build` before building the .dxt bundle.");
  }
  if (!existsSync(join(root, "node_modules"))) {
    fail("node_modules not found. Install production deps (`npm ci --omit=dev`) before bundling.");
  }
}

/** Try the official packer. Returns true if it ran and succeeded. */
function tryOfficialPacker() {
  // `dxt pack <dir> <output>` packs a directory whose root holds manifest.json.
  // We stage the verified file list into a temp dir, then point the packer at it.
  log("attempting official packer: npx @anthropic-ai/dxt pack …");
  const probe = spawnSync("npx", ["--yes", "@anthropic-ai/dxt", "--version"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (probe.status !== 0) {
    log("official packer not available — falling back to built-in zip.");
    return false;
  }

  const stageDir = mkdtempSync(join(tmpdir(), "tdmcp-dxt-"));
  try {
    for (const [src, dest] of INCLUDE) {
      if (!existsSync(src)) continue;
      const target = join(stageDir, dest);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(src, target, { recursive: true });
    }
    const res = spawnSync("npx", ["--yes", "@anthropic-ai/dxt", "pack", stageDir, outFile], {
      cwd: root,
      encoding: "utf8",
      stdio: "inherit",
    });
    if (res.status === 0) {
      log(`official packer produced ${outFile}`);
      return true;
    }
    log("official packer failed — falling back to built-in zip.");
    return false;
  } finally {
    rmSync(stageDir, { recursive: true, force: true });
  }
}

/** Fallback: assemble the .dxt with the system `zip` tool. */
function zipFallback() {
  const hasZip = spawnSync("zip", ["-v"], { stdio: "ignore" }).status === 0;
  if (!hasZip) {
    fail(
      "neither `npx @anthropic-ai/dxt` nor a system `zip` is available.\n" +
        "  Install one of them, e.g.:\n" +
        "    npm i -g @anthropic-ai/dxt   # then re-run this script\n" +
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
