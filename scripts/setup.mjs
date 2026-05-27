// Guided one-command setup for people who cloned the repo.
//
//   npm run setup      (or ./setup.sh)
//
// Verifies Node, installs deps, builds, then prints the exact lines to connect
// your AI client and switch the TouchDesigner bridge on — with this folder's
// real absolute path already filled in. Pure Node builtins, no dependencies.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distEntry = join(root, "dist", "index.js");
const bridgeModules = join(root, "td", "modules");

function say(msg = "") {
  process.stdout.write(`${msg}\n`);
}

function run(cmd, args) {
  say(`\n▶ ${cmd} ${args.join(" ")}`);
  const res = spawnSync(cmd, args, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (res.status !== 0) {
    say(
      `\n✖ \`${cmd} ${args.join(" ")}\` failed. Fix the error above and re-run \`npm run setup\`.`,
    );
    process.exit(res.status ?? 1);
  }
}

// 1. Node version gate.
const major = Number(process.versions.node.split(".")[0]);
if (Number.isFinite(major) && major < 20) {
  say(`✖ Node ${process.versions.node} detected — tdmcp needs Node 20 or newer.`);
  say("  Install it from https://nodejs.org and run `npm run setup` again.");
  process.exit(1);
}

// 2. Install + build.
if (!existsSync(join(root, "node_modules"))) {
  run("npm", ["install"]);
} else {
  say("✓ node_modules present — skipping install (delete it to force a clean install).");
}
run("npm", ["run", "build"]);

if (!existsSync(distEntry)) {
  say(`\n✖ Build finished but ${distEntry} is missing. Something went wrong above.`);
  process.exit(1);
}

// 3. Print copy-paste next steps with the real path baked in.
const line = "─".repeat(64);
say(`\n${line}`);
say("✓ tdmcp is built and ready.");
say(line);
say("\nSTEP A — Connect your AI assistant (pick one):\n");
say("  Claude Code:");
say(`    claude mcp add tdmcp -- node ${distEntry}\n`);
say("  Claude Desktop — add to claude_desktop_config.json:");
say("    {");
say('      "mcpServers": {');
say('        "tdmcp": {');
say('          "command": "node",');
say(`          "args": [${JSON.stringify(distEntry)}]`);
say("        }");
say("      }");
say("    }\n");
say("  Claude Desktop one-click instead? Build the extension: npm run build:dxt");
say("    then drag tdmcp.dxt into Claude Desktop → Settings → Extensions.\n");
say("STEP B — Switch the bridge on inside TouchDesigner:\n");
say('  1. Preferences → "Python 64-bit Module Path", add:');
say(`       ${bridgeModules}`);
say("  2. Textport (Dialogs → Textport and DATs), run:");
say("       from mcp import install; install.run()\n");
say("  Don't want to touch Preferences? Run this instead and follow the output:");
say(`       node ${distEntry} install-bridge\n`);
say("STEP C — (optional) Local copilot for the simple stuff:\n");
say("  Talk to a local LLM in your browser instead of a paid API — same bridge,");
say("  good for inspecting and tweaking single operators. For full systems, use");
say("  Claude/Codex from STEP A.\n");
say("    1. Install Ollama from https://ollama.com");
say("    2. ollama pull qwen2.5:3b");
say(`    3. node ${distEntry} chat        (opens http://127.0.0.1:4141)\n`);
say(`${line}`);
say("Full guide: README.md   •   TD bridge details: td/README.md");
say(line);
