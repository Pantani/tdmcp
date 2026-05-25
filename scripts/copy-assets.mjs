// Copies runtime assets (knowledge data + recipes) into dist so the published
// package can resolve them relative to the compiled output. Safe to run even
// when an asset directory is missing (e.g. before `import:bottobot`).
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** @param {string} from @param {string} to */
function copy(from, to) {
  const src = resolve(root, from);
  if (!existsSync(src)) {
    console.warn(`[copy-assets] skip (missing): ${from}`);
    return;
  }
  const dest = resolve(root, to);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true });
  console.log(`[copy-assets] ${from} -> ${to}`);
}

copy("src/knowledge/data", "dist/knowledge/data");
copy("recipes", "dist/recipes");
