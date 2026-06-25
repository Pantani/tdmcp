#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { ESLint } from "eslint";
import sonarjs from "eslint-plugin-sonarjs";
import tseslint from "typescript-eslint";

const defaultBaseline = "eslint-cognitive-baseline.json";
const defaultThreshold = 9;
const lintTargets = ["src/**/*.{ts,tsx,js,mjs,cjs}", "scripts/**/*.{js,mjs,cjs}", "*.{js,mjs,cjs}"];

function normalizeSignature(value) {
  return value.replace(/\s+/g, " ").trim();
}

function signatureFromLine(line) {
  const trimmed = normalizeSignature(line);
  const patterns = [
    /\b(?:async\s+)?function\s+\*?\s*([A-Za-z_$][\w$]*)\s*\(/,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?function\b/,
    /\b(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*[:\w<>,\s[\]|&?.]*\s*\{/,
    /\b([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>)/,
  ];
  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function sourceSignature(source, line) {
  const lines = source.split(/\r?\n/);
  for (let index = line - 1; index >= Math.max(0, line - 8); index--) {
    const signature = signatureFromLine(lines[index] ?? "");
    if (signature) return signature;
  }
  return normalizeSignature(lines[line - 1] ?? "");
}

function withStableKeys(entries) {
  const counts = new Map();
  return entries.map((entry) => {
    const baseKey = `${entry.file}:${entry.signature || `line:${entry.line}:col:${entry.column}`}`;
    const count = counts.get(baseKey) ?? 0;
    counts.set(baseKey, count + 1);
    return {
      ...entry,
      stableKey: count === 0 ? baseKey : `${baseKey}#${count + 1}`,
    };
  });
}

function parseArgs(argv) {
  const options = {
    baseline: defaultBaseline,
    threshold: defaultThreshold,
    updateBaseline: false,
  };
  for (const arg of argv) {
    if (arg === "--update-baseline") options.updateBaseline = true;
    else if (arg.startsWith("--baseline=")) options.baseline = arg.slice("--baseline=".length);
    else if (arg.startsWith("--threshold="))
      options.threshold = Number(arg.slice("--threshold=".length));
  }
  if (!Number.isInteger(options.threshold) || options.threshold < 1) {
    throw new Error("--threshold must be a positive integer.");
  }
  return options;
}

function entryKey(entry) {
  if (typeof entry.stableKey === "string" && entry.stableKey.length > 0) return entry.stableKey;
  return `${entry.file}:${entry.line}:${entry.column}`;
}

function legacyEntryKey(entry) {
  return `${entry.file}:${entry.line}:${entry.column}`;
}

function parseComplexity(message) {
  const match = message.match(/from (\d+) to the \d+ allowed/);
  return match ? Number(match[1]) : undefined;
}

async function collectViolations(threshold) {
  const sourceCache = new Map();
  const sourceFor = (filePath) => {
    let source = sourceCache.get(filePath);
    if (source === undefined) {
      source = readFileSync(filePath, "utf8");
      sourceCache.set(filePath, source);
    }
    return source;
  };
  const eslint = new ESLint({
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ["**/*.{ts,tsx,js,mjs,cjs}"],
        ignores: ["dist/**", "docs/.vitepress/cache/**", "src/knowledge/data/**"],
        languageOptions: {
          parser: tseslint.parser,
          parserOptions: { ecmaVersion: "latest", sourceType: "module" },
        },
        plugins: { sonarjs },
        rules: { "sonarjs/cognitive-complexity": ["error", threshold] },
      },
    ],
  });
  const results = await eslint.lintFiles(lintTargets);
  const entries = results
    .flatMap((result) =>
      result.messages
        .filter((message) => message.ruleId === "sonarjs/cognitive-complexity")
        .map((message) => ({
          file: path.relative(process.cwd(), result.filePath).split(path.sep).join("/"),
          line: message.line,
          column: message.column,
          complexity: parseComplexity(message.message),
          signature: sourceSignature(sourceFor(result.filePath), message.line),
          message: message.message,
        })),
    )
    .sort((a, b) => legacyEntryKey(a).localeCompare(legacyEntryKey(b)));
  return withStableKeys(entries).sort((a, b) => entryKey(a).localeCompare(entryKey(b)));
}

function readBaseline(filename) {
  if (!existsSync(filename)) return [];
  return JSON.parse(readFileSync(filename, "utf8"));
}

function compareWithBaseline(current, baseline) {
  const baselineByKey = new Map(baseline.map((entry) => [entryKey(entry), entry]));
  const legacyBaselineByKey = new Map(baseline.map((entry) => [legacyEntryKey(entry), entry]));
  const relocatedBaseline = [...baseline];
  const failures = [];
  for (const entry of current) {
    const previous =
      baselineByKey.get(entryKey(entry)) ??
      legacyBaselineByKey.get(legacyEntryKey(entry)) ??
      relocatedBaseline.find(
        (candidate) =>
          candidate.file === entry.file &&
          candidate.complexity === entry.complexity &&
          candidate.signature === undefined,
      );
    if (!previous) {
      failures.push({ kind: "new", entry });
      continue;
    }
    const relocatedIndex = relocatedBaseline.indexOf(previous);
    if (relocatedIndex !== -1) relocatedBaseline.splice(relocatedIndex, 1);
    if (entry.complexity > previous.complexity) {
      failures.push({ kind: "worse", entry, previous });
    }
  }
  return failures;
}

function formatFailure(failure) {
  const { entry } = failure;
  const suffix =
    failure.kind === "worse"
      ? ` worsened from ${failure.previous.complexity} to ${entry.complexity}`
      : " is not in the baseline";
  return `${entry.file}:${entry.line}:${entry.column} cognitive complexity ${entry.complexity}${suffix}`;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const current = await collectViolations(options.threshold);
  if (options.updateBaseline) {
    writeFileSync(options.baseline, `${JSON.stringify(current, null, 2)}\n`);
    console.log(`Updated ${options.baseline} with ${current.length} JS/TS cognitive violations.`);
    return 0;
  }

  const failures = compareWithBaseline(current, readBaseline(options.baseline));
  if (failures.length > 0) {
    console.error(`JS/TS cognitive complexity ratchet failed (${failures.length} regression(s)).`);
    for (const failure of failures.slice(0, 30)) console.error(`- ${formatFailure(failure)}`);
    if (failures.length > 30) console.error(`- ... ${failures.length - 30} more`);
    return 1;
  }

  console.log(`JS/TS cognitive complexity ratchet passed (${current.length} existing violations).`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => {
    process.exitCode = code;
  });
}
