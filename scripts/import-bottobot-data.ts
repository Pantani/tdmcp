/**
 * Imports the TouchDesigner knowledge base from `@bottobot/td-mcp` into
 * `src/knowledge/data/`. Safe to re-run. If the package is missing, writes an
 * empty-but-valid structure and exits 0 (build/test must never break on this).
 *
 *   npm run import:bottobot
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizeGlsl,
  normalizePatterns,
  toOperatorSummary,
  toPythonSummary,
  toTutorialSummary,
} from "../src/knowledge/normalize.js";
import type { OperatorDoc, PythonClass, Tutorial } from "../src/knowledge/types.js";
import { bottobotPackageDir } from "../src/utils/paths.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "src/knowledge/data");

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data));
}

function readExistingMeta(): {
  importedAt?: string;
  source?: string;
  bottobotVersion?: string;
  counts?: unknown;
} {
  const metaPath = join(outDir, "meta.json");
  if (!existsSync(metaPath)) return {};
  try {
    return readJson(metaPath) as {
      importedAt?: string;
      source?: string;
      bottobotVersion?: string;
      counts?: unknown;
    };
  } catch {
    return {};
  }
}

function listJson(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "index.json");
}

function freshDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

function writeEmpty(): void {
  freshDir(outDir);
  mkdirSync(join(outDir, "operators"), { recursive: true });
  mkdirSync(join(outDir, "python-api"), { recursive: true });
  mkdirSync(join(outDir, "tutorials"), { recursive: true });
  writeJson(join(outDir, "operators", "index.json"), []);
  writeJson(join(outDir, "python-api", "index.json"), []);
  writeJson(join(outDir, "tutorials", "index.json"), []);
  writeJson(join(outDir, "patterns.json"), []);
  writeJson(join(outDir, "glsl.json"), []);
  writeJson(join(outDir, "meta.json"), {
    source: "empty",
    importedAt: new Date().toISOString(),
  });
}

function main(): void {
  const bb = bottobotPackageDir();
  const existingMeta = readExistingMeta();
  if (!bb) {
    console.warn(
      "[import] @bottobot/td-mcp not found. Run `npm install @bottobot/td-mcp`, then re-run `npm run import:bottobot`.",
    );
    console.warn("[import] Wrote empty knowledge structure so build/test still pass.");
    writeEmpty();
    return;
  }

  const processedDir = join(bb, "wiki/data/processed");
  const pythonDir = join(bb, "wiki/data/python-api");
  const tutorialsDir = join(bb, "wiki/data/tutorials");

  freshDir(outDir);

  // Operators — copy verbatim, then build a summary index.
  const opOut = join(outDir, "operators");
  cpSync(processedDir, opOut, { recursive: true });
  const opIndex = [];
  for (const file of listJson(opOut)) {
    const doc = readJson(join(opOut, file)) as OperatorDoc;
    if (doc?.name) opIndex.push(toOperatorSummary(file.replace(/\.json$/, ""), doc));
  }
  writeJson(join(opOut, "index.json"), opIndex);

  // Python API.
  const pyOut = join(outDir, "python-api");
  cpSync(pythonDir, pyOut, { recursive: true });
  const pyIndex = [];
  for (const file of listJson(pyOut)) {
    const cls = readJson(join(pyOut, file)) as PythonClass;
    if (cls?.className) pyIndex.push(toPythonSummary(cls));
  }
  writeJson(join(pyOut, "index.json"), pyIndex);

  // Tutorials.
  const tutOut = join(outDir, "tutorials");
  cpSync(tutorialsDir, tutOut, { recursive: true });
  const tutIndex = [];
  for (const file of listJson(tutOut)) {
    const tut = readJson(join(tutOut, file)) as Tutorial;
    const id = tut?.id ?? file.replace(/\.json$/, "");
    const name = tut?.name ?? id;
    tutIndex.push(toTutorialSummary({ ...tut, id, name }));
  }
  writeJson(join(tutOut, "index.json"), tutIndex);

  // Patterns + GLSL (single normalized files).
  const patterns = normalizePatterns(readJson(join(bb, "data/patterns.json")));
  writeJson(join(outDir, "patterns.json"), patterns);
  const glsl = normalizeGlsl(readJson(join(bb, "wiki/data/experimental/glsl.json")));
  writeJson(join(outDir, "glsl.json"), glsl);

  let bottobotVersion = "unknown";
  try {
    const pkg = readJson(join(bb, "package.json")) as { version?: string };
    bottobotVersion = pkg.version ?? "unknown";
  } catch {
    // ignore
  }

  const counts = {
    operators: opIndex.length,
    pythonClasses: pyIndex.length,
    tutorials: tutIndex.length,
    patterns: patterns.length,
    glsl: glsl.length,
  };
  const unchangedMeta =
    existingMeta.source === "bottobot" &&
    existingMeta.bottobotVersion === bottobotVersion &&
    JSON.stringify(existingMeta.counts) === JSON.stringify(counts);
  writeJson(join(outDir, "meta.json"), {
    source: "bottobot",
    bottobotVersion,
    importedAt: unchangedMeta ? existingMeta.importedAt : new Date().toISOString(),
    counts,
  });

  console.log(`[import] Imported from @bottobot/td-mcp@${bottobotVersion}:`, counts);
}

main();
