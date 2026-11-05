#!/usr/bin/env node
// Enforces that tests/smoke/bridgeExecOff.baseline.json only shrinks in a PR.
//
// The vitest smoke compares tools against the committed baseline, so it cannot see
// a PR that edits both a tool and its baseline entry. This compares the baseline to
// the PR's base commit. A deliberate new exec dependency needs the
// `exec-off-baseline-growth` PR label, which sets EXEC_OFF_ALLOW_GROWTH=1 in CI.
//
//   node scripts/check-exec-off-baseline.mjs <base-sha>

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const BASELINE = "tests/smoke/bridgeExecOff.baseline.json";
// Most to least capable; a tool may only move left. Absent from the file = clean.
const ORDER = ["clean", "placement_only", "degraded", "blocked", "unverified"];

function statusByTool(json) {
  const byTool = new Map();
  for (const status of ORDER.slice(1)) {
    for (const tool of json[status] ?? []) byTool.set(tool, status);
  }
  return byTool;
}

export function baselineGrowth(baseJson, headJson) {
  const base = statusByTool(baseJson);
  const growth = [];
  for (const [tool, status] of statusByTool(headJson)) {
    const was = base.get(tool) ?? "clean";
    if (ORDER.indexOf(status) > ORDER.indexOf(was)) growth.push(`${tool}: ${was} -> ${status}`);
  }
  return growth.sort();
}

function readBaseBaseline(baseSha) {
  try {
    const text = execFileSync("git", ["show", `${baseSha}:${BASELINE}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(text);
  } catch (err) {
    // Git words this differently depending on whether the file exists in the worktree.
    if (/does not exist|exists on disk, but not in/.test(String(err.stderr ?? ""))) {
      return undefined;
    }
    throw err;
  }
}

function main() {
  const baseSha = process.argv[2];
  if (!baseSha) {
    console.error("usage: check-exec-off-baseline.mjs <base-sha>");
    process.exit(2);
  }
  const base = readBaseBaseline(baseSha);
  if (!base) {
    console.log(`No ${BASELINE} at ${baseSha}; this PR introduces it.`);
    return;
  }
  const growth = baselineGrowth(base, JSON.parse(readFileSync(BASELINE, "utf8")));
  if (growth.length === 0) {
    console.log("Exec-off baseline did not grow.");
    return;
  }
  console.error(`Exec-off baseline grew against ${baseSha}:\n  ${growth.join("\n  ")}`);
  if (process.env.EXEC_OFF_ALLOW_GROWTH === "1") {
    console.error("Allowed by the exec-off-baseline-growth label.");
    return;
  }
  console.error(
    "Prefer a first-class bridge endpoint. If this dependency is intended, a maintainer can add the exec-off-baseline-growth label.",
  );
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
