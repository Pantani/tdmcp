#!/usr/bin/env node
// Launcher for dotsimulate's LOPs "MCP Client": injects hardening env, then
// execs the tdmcp stdio server. LOPs' servers_config.json has no documented
// `env` field, so point its `command` at this file instead.
//
//   command: "node"
//   args: ["/abs/path/to/tdmcp/scripts/tdmcp-lops.mjs"]
//
// Sets TDMCP_RAW_PYTHON=off and TDMCP_TOOL_PROFILE=safe so an autonomous in-TD
// agent gets the curated, non-destructive tool surface. These are FORCED
// (override anything inherited from the parent) — hardening must win.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = resolve(root, "dist", "index.js");

if (!existsSync(entry)) {
  // stderr ONLY — stdout is the MCP stdio channel and must stay clean.
  process.stderr.write(
    `[tdmcp-lops] ${entry} not found. Run \`npm run build\` in ${root} first.\n`,
  );
  process.exit(1);
}

const env = {
  ...process.env,
  TDMCP_RAW_PYTHON: "off",
  TDMCP_TOOL_PROFILE: "safe",
};

const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], {
  stdio: "inherit", // pipe stdin/stdout/stderr straight through (MCP handshake)
  env,
});

child.on("error", (err) => {
  process.stderr.write(`[tdmcp-lops] failed to start tdmcp: ${err.message}\n`);
  process.exit(1);
});
child.on("close", (code) => process.exit(code ?? 1));
