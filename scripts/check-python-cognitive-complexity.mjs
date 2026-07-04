#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const defaultBaseline = "complexipy-cognitive-baseline.json";
const defaultThreshold = 9;

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
  return `${entry.path}:${entry.function}`;
}

function readBaseline(filename) {
  if (!existsSync(filename)) return [];
  return JSON.parse(readFileSync(filename, "utf8"));
}

function normalize(entry) {
  return {
    path: entry.path,
    function: entry.function_name,
    complexity: entry.complexity,
  };
}

// Pin complexipy: uvx otherwise resolves the latest release at run time, and complexipy
// 6.0.0 re-scored cognitive complexity upward, drifting every baseline entry at once (a
// CI break unrelated to any diff). 5.6.1 is the newest release whose scores match the
// committed baseline. Bump this deliberately + regenerate the baseline
// (npm run complexity:cognitive:py:update) when upgrading.
const COMPLEXIPY_SPEC = "complexipy==5.6.1";

function collectViolations(threshold) {
  const dir = mkdtempSync(path.join(tmpdir(), "tdmcp-complexipy-"));
  const output = path.join(dir, "complexipy.json");
  try {
    const result = spawnSync(
      "uvx",
      [
        "--from",
        COMPLEXIPY_SPEC,
        "complexipy",
        "td",
        "--max-complexity-allowed",
        String(threshold),
        "--failed",
        "--quiet",
        "--snapshot-ignore",
        "--output-format",
        "json",
        "--output",
        output,
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    if (![0, 1].includes(result.status ?? 1)) {
      process.stderr.write(result.stderr);
      process.stderr.write(result.stdout);
      throw new Error(`complexipy failed with exit code ${result.status ?? 1}`);
    }
    if (!existsSync(output)) return [];
    return JSON.parse(readFileSync(output, "utf8"))
      .map(normalize)
      .sort((a, b) => entryKey(a).localeCompare(entryKey(b)));
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
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
  return `${entry.path} ${entry.function} cognitive complexity ${entry.complexity}${suffix}`;
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const current = collectViolations(options.threshold);
  if (options.updateBaseline) {
    writeFileSync(options.baseline, `${JSON.stringify(current, null, 2)}\n`);
    console.log(`Updated ${options.baseline} with ${current.length} Python cognitive violations.`);
    return 0;
  }

  const failures = compareWithBaseline(current, readBaseline(options.baseline));
  if (failures.length > 0) {
    console.error(`Python cognitive complexity ratchet failed (${failures.length} regression(s)).`);
    for (const failure of failures.slice(0, 30)) console.error(`- ${formatFailure(failure)}`);
    if (failures.length > 30) console.error(`- ... ${failures.length - 30} more`);
    return 1;
  }

  console.log(
    `Python cognitive complexity ratchet passed (${current.length} existing violations).`,
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main();
}
