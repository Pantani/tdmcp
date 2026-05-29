#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const defaultOutput = "_workspace/coverage/latest.md";

function parseArgs(argv) {
  const options = {
    limit: 20,
    minLines: undefined,
    output: defaultOutput,
    summaryOnly: false,
  };

  for (const arg of argv) {
    if (arg === "--summary-only" || arg === "--skip-run") {
      options.summaryOnly = true;
      continue;
    }

    const [name, value] = arg.split("=", 2);
    if (name === "--limit" && value) options.limit = Number.parseInt(value, 10);
    if (name === "--min-lines" && value) options.minLines = Number.parseFloat(value);
    if (name === "--output" && value) options.output = value;
  }

  if (!Number.isFinite(options.limit) || options.limit < 1) options.limit = 20;
  return options;
}

function runCoverage() {
  const result = spawnSync(
    "npm",
    [
      "run",
      "test:coverage",
      "--",
      "--coverage.reporter=json-summary",
      "--coverage.reporter=text-summary",
    ],
    {
      cwd: rootDir,
      shell: process.platform === "win32",
      stdio: "inherit",
    },
  );

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function readSummary() {
  const summaryPath = path.join(rootDir, "coverage", "coverage-summary.json");
  return JSON.parse(readFileSync(summaryPath, "utf8"));
}

function relPath(filename) {
  return path.relative(rootDir, filename).split(path.sep).join("/");
}

function pct(value) {
  return `${value.toFixed(2)}%`;
}

function metricRow(label, metric) {
  return `| ${label} | ${metric.covered} / ${metric.total} | ${pct(metric.pct)} |`;
}

function fileRows(summary) {
  return Object.entries(summary)
    .filter(([filename]) => filename !== "total")
    .map(([filename, data]) => ({
      file: relPath(filename),
      lines: data.lines,
      statements: data.statements,
      functions: data.functions,
      branches: data.branches,
    }))
    .filter((row) => row.file.startsWith("src/"))
    .filter((row) => row.file.endsWith(".ts"))
    .filter((row) => !row.file.startsWith("src/knowledge/data/"))
    .filter((row) => row.lines.total > 0);
}

function missing(metric) {
  return metric.total - metric.covered;
}

function gapScore(row) {
  return missing(row.lines) * 3 + missing(row.functions) * 2 + missing(row.branches);
}

function surfaceFor(file) {
  if (file === "src/index.ts" || file.startsWith("src/cli/") || file.startsWith("src/llm/")) {
    return "entrypoints-cli-llm";
  }
  if (file.startsWith("src/resources/") || file.startsWith("src/knowledge/")) {
    return "resources-knowledge";
  }
  if (file.startsWith("src/prompts/")) return "prompts";
  if (file.startsWith("src/tools/")) return "tools";
  if (file.startsWith("src/server/") || file.startsWith("src/td-client/")) {
    return "server-transport";
  }
  return "other";
}

function summarizeSurfaces(rows) {
  const surfaces = new Map();
  for (const row of rows) {
    const surface = surfaceFor(row.file);
    const current = surfaces.get(surface) ?? {
      surface,
      files: 0,
      covered: 0,
      total: 0,
      missing: 0,
      topFiles: [],
    };
    current.files++;
    current.covered += row.lines.covered;
    current.total += row.lines.total;
    current.missing += missing(row.lines);
    current.topFiles.push(row);
    surfaces.set(surface, current);
  }

  return [...surfaces.values()]
    .map((surface) => ({
      ...surface,
      pct: surface.total === 0 ? 100 : (surface.covered / surface.total) * 100,
      topFiles: surface.topFiles.sort((a, b) => gapScore(b) - gapScore(a)).slice(0, 3),
    }))
    .sort((a, b) => b.missing - a.missing);
}

function makeMarkdown(summary, rows, options) {
  const gaps = [...rows].sort((a, b) => gapScore(b) - gapScore(a)).slice(0, options.limit);
  const surfaces = summarizeSurfaces(rows).slice(0, 6);
  const generatedAt = new Date().toISOString();

  const lines = [
    "# Test Coverage Harness Report",
    "",
    `Generated: ${generatedAt}`,
    "",
    "Scope: TypeScript source files under `src/**/*.ts`. Generated knowledge JSON is excluded so the report tracks executable code, not imported reference data.",
    "",
    "## Summary",
    "",
    "| Metric | Covered | Percent |",
    "|---|---:|---:|",
    metricRow("Statements", summary.total.statements),
    metricRow("Branches", summary.total.branches),
    metricRow("Functions", summary.total.functions),
    metricRow("Lines", summary.total.lines),
    "",
    "## Top Gaps",
    "",
    "| Rank | File | Lines | Functions | Branches | Missing lines |",
    "|---:|---|---:|---:|---:|---:|",
  ];

  gaps.forEach((row, index) => {
    lines.push(
      `| ${index + 1} | \`${row.file}\` | ${pct(row.lines.pct)} | ${pct(
        row.functions.pct,
      )} | ${pct(row.branches.pct)} | ${missing(row.lines)} |`,
    );
  });

  lines.push("", "## Suggested Test Waves", "");
  for (const surface of surfaces) {
    const files = surface.topFiles.map((row) => `\`${row.file}\``).join(", ");
    lines.push(
      `- ${surface.surface}: ${surface.missing} uncovered lines across ${
        surface.files
      } files (${pct(surface.pct)} lines). Start with ${files}.`,
    );
  }

  lines.push(
    "",
    "## Harness Commands",
    "",
    "- `npm run coverage:harness` - run coverage and write this report.",
    "- `npm run coverage:harness -- --summary-only` - regenerate this report from the existing `coverage/coverage-summary.json`.",
    "- `npm run coverage:harness -- --limit=40 --min-lines=87` - print more gaps and fail if line coverage is below the requested floor.",
    "- `npm run test:coverage` - run the raw Vitest coverage gate.",
    "",
  );

  return `${lines.join("\n")}\n`;
}

function writeReport(markdown, output) {
  const outputPath = path.resolve(rootDir, output);
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, markdown);
  return outputPath;
}

const options = parseArgs(process.argv.slice(2));

if (!options.summaryOnly) runCoverage();

const summary = readSummary();
const rows = fileRows(summary);
const markdown = makeMarkdown(summary, rows, options);
const reportPath = writeReport(markdown, options.output);

console.log(`Coverage report written to ${path.relative(rootDir, reportPath)}`);

if (options.minLines !== undefined && summary.total.lines.pct < options.minLines) {
  console.error(
    `Line coverage ${pct(summary.total.lines.pct)} is below required ${pct(options.minLines)}.`,
  );
  process.exit(1);
}
