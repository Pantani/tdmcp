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
  return `${entry.file}:${entry.line}:${entry.column}`;
}

function parseComplexity(message) {
  const match = message.match(/from (\d+) to the \d+ allowed/);
  return match ? Number(match[1]) : undefined;
}

async function collectViolations(threshold) {
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
  return results
    .flatMap((result) =>
      result.messages
        .filter((message) => message.ruleId === "sonarjs/cognitive-complexity")
        .map((message) => ({
          file: path.relative(process.cwd(), result.filePath).split(path.sep).join("/"),
          line: message.line,
          column: message.column,
          complexity: parseComplexity(message.message),
          message: message.message,
        })),
    )
    .sort((a, b) => entryKey(a).localeCompare(entryKey(b)));
}

function readBaseline(filename) {
  if (!existsSync(filename)) return [];
  return JSON.parse(readFileSync(filename, "utf8"));
}

function compareWithBaseline(current, baseline) {
  const baselineByKey = new Map(baseline.map((entry) => [entryKey(entry), entry]));
  const failures = [];
  for (const entry of current) {
    const previous = baselineByKey.get(entryKey(entry));
    if (!previous) {
      failures.push({ kind: "new", entry });
      continue;
    }
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
