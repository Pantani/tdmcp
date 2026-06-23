// Syncs published metadata "version" fields to match `package.json`.
//
// Runs automatically as the npm `version` lifecycle script: `npm version <bump>`
// bumps package.json, then this runs and stages the manifests, then npm makes
// the version commit + tag. That keeps published security/package metadata from
// drifting away from the package version.
//
// A surgical text replace is used (not JSON.stringify) so the manifest keeps its
// exact formatting and stays Biome-clean.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPaths = [join(root, "dxt", "manifest.json"), join(root, "safeskill.manifest.json")];
const serverPath = join(root, "server.json");
const bootstrapPinPaths = [
  join(root, "td", "bootstrap.py"),
  join(root, "td", "modules", "mcp", "install.py"),
  join(root, "README.md"),
  join(root, "td", "README.md"),
  join(root, "docs", "guide", "codex.md"),
  join(root, "docs", "guide", "install.md"),
  join(root, "docs", "guide", "local-copilot.md"),
  join(root, "docs", "pt", "guide", "codex.md"),
  join(root, "docs", "pt", "guide", "install.md"),
  join(root, "docs", "pt", "guide", "local-copilot.md"),
  join(root, "docs", "reference", "bridge-api.md"),
];

const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
if (!version) {
  process.stderr.write("[sync-manifest-version] package.json has no version\n");
  process.exit(1);
}

for (const manifestPath of manifestPaths) {
  const before = readFileSync(manifestPath, "utf8");
  // Matches the top-level `"version": "x.y.z"` only — `"manifest_version"` has no
  // leading quote before `version`, so it is never matched.
  const after = before.replace(/("version"\s*:\s*")[^"]*"/, `$1${version}"`);

  if (after === before) {
    process.stdout.write(`[sync-manifest-version] ${manifestPath} already at ${version}\n`);
  } else {
    writeFileSync(manifestPath, after);
    process.stdout.write(`[sync-manifest-version] ${manifestPath} -> ${version}\n`);
  }
}

{
  const before = readFileSync(serverPath, "utf8");
  const after = before
    .replace(/("version"\s*:\s*")[^"]*"/, `$1${version}"`)
    .replace(/("packages"\s*:\s*\[\s*\{[\s\S]*?"version"\s*:\s*")[^"]*"/, `$1${version}"`);

  if (after === before) {
    process.stdout.write(`[sync-manifest-version] ${serverPath} already at ${version}\n`);
  } else {
    writeFileSync(serverPath, after);
    process.stdout.write(`[sync-manifest-version] ${serverPath} -> ${version}\n`);
  }
}

for (const filePath of bootstrapPinPaths) {
  const before = readFileSync(filePath, "utf8");
  const after = before
    .replace(
      /github\.com\/Pantani\/tdmcp\/raw\/(?:main|v\d+\.\d+\.\d+)\/td\/bootstrap\.py/g,
      `github.com/Pantani/tdmcp/raw/v${version}/td/bootstrap.py`,
    )
    .replace(
      /github\.com\/Pantani\/tdmcp\/archive\/refs\/(?:heads\/main|tags\/v\d+\.\d+\.\d+)\.zip/g,
      `github.com/Pantani/tdmcp/archive/refs/tags/v${version}.zip`,
    );

  if (after === before) {
    process.stdout.write(
      `[sync-manifest-version] ${filePath} bootstrap pins already at ${version}\n`,
    );
  } else {
    writeFileSync(filePath, after);
    process.stdout.write(`[sync-manifest-version] ${filePath} bootstrap pins -> ${version}\n`);
  }
}
