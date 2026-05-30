#!/usr/bin/env node
// set-status.mjs — idempotent ledger status patcher for the campaign.
// Usage: node _workspace/build/set-status.mjs <id>=<status> [<id>=<status> ...]
//        node _workspace/build/set-status.mjs <id>=<status> --files a.ts,b.ts --note "msg"
// Bumps `attempts` automatically when moving INTO in_progress. Regenerates LEDGER.md.
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

const OUT = join(process.cwd(), "_workspace", "build");
const LEDGER = join(OUT, "ledger.json");
const DATE = "2026-05-30";
const VALID = new Set([
  "pending", "in_progress", "built", "integrated",
  "qa_pass", "qa_unverified", "done", "blocked", "deferred",
]);

const args = process.argv.slice(2);
const pairs = [];
let files = null, note = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--files") { files = args[++i].split(",").map((s) => s.trim()).filter(Boolean); }
  else if (args[i] === "--note") { note = args[++i]; }
  else if (args[i].includes("=")) { const [id, st] = args[i].split("="); pairs.push([id, st]); }
}
if (!pairs.length) { console.error("no <id>=<status> pairs"); process.exit(1); }

const ledger = JSON.parse(readFileSync(LEDGER, "utf8"));
const byId = new Map(ledger.features.map((f) => [f.id, f]));
const changed = [];
for (const [id, st] of pairs) {
  if (!VALID.has(st)) { console.error(`invalid status: ${st}`); process.exit(1); }
  const f = byId.get(id);
  if (!f) { console.error(`unknown feature: ${id}`); process.exit(1); }
  if (st === "in_progress" && f.status !== "in_progress") f.attempts = (f.attempts || 0) + 1;
  f.status = st;
  if (files) f.files = files;
  if (note !== null) f.notes = note;
  f.last_updated = DATE;
  changed.push(`${id}→${st}`);
}
ledger.updated = DATE;
writeFileSync(LEDGER, `${JSON.stringify(ledger, null, 2)}\n`);
try { execSync("node .claude/skills/tdmcp-backlog-campaign/init-ledger.mjs", { stdio: "ignore" }); } catch { /* LEDGER.md regen best-effort */ }
console.log("set:", changed.join(" "));
