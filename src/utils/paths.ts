import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = dirname(fileURLToPath(import.meta.url));

function firstExisting(candidates: string[], fallback: string): string {
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return fallback;
}

/**
 * Directory holding the imported knowledge base JSON.
 * - dev (tsx): `<root>/src/knowledge/data`
 * - build (node): `<root>/dist/knowledge/data` (copied by `copy-assets.mjs`)
 */
export function knowledgeDataDir(): string {
  return firstExisting(
    [resolve(moduleDir, "../knowledge/data"), resolve(moduleDir, "knowledge/data")],
    resolve(moduleDir, "../knowledge/data"),
  );
}

/**
 * Directory holding recipe JSON files.
 * - dev: `<root>/recipes`
 * - build: `<root>/dist/recipes`
 */
export function recipesDir(): string {
  return firstExisting(
    [resolve(moduleDir, "../../recipes"), resolve(moduleDir, "recipes")],
    resolve(moduleDir, "../../recipes"),
  );
}

/**
 * Resolves the installed `@bottobot/td-mcp` package root (the source of operator
 * data), if present. Used as a fallback when local knowledge data is missing.
 */
export function bottobotPackageDir(): string | undefined {
  const candidates = [
    resolve(moduleDir, "../../node_modules/@bottobot/td-mcp"),
    resolve(moduleDir, "../node_modules/@bottobot/td-mcp"),
    resolve(process.cwd(), "node_modules/@bottobot/td-mcp"),
  ];
  for (const candidate of candidates) {
    if (existsSync(resolve(candidate, "wiki/data/processed"))) return candidate;
  }
  return undefined;
}
