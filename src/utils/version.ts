import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let cached: string | undefined;

/**
 * Resolves the package version by walking up from this module until it finds
 * the `tdmcp` package.json. Works both in dev (tsx, from `src/`) and in
 * the bundled build (from `dist/`). Falls back to "0.0.0" if not found.
 */
export function getVersion(): string {
  if (cached) return cached;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    try {
      const raw = readFileSync(resolve(dir, "package.json"), "utf8");
      const pkg = JSON.parse(raw) as { name?: string; version?: string };
      // Accept the current npm package name plus the legacy scoped name so a
      // migrated install cannot silently drop us to the fallback.
      if (pkg.version && (pkg.name === "@dpantani/tdmcp" || pkg.name === "tdmcp")) {
        cached = pkg.version;
        return cached;
      }
    } catch {
      // package.json not here — keep walking up
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  cached = "0.0.0";
  return cached;
}
