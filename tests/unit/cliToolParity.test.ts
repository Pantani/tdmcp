import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * CLI ↔ tool parity gate: every exported `…Impl` tool handler under src/tools
 * must be wired into the tdmcp-agent COMMANDS map in src/cli/agent.ts.
 *
 * Tools that must intentionally stay MCP-only go in ALLOWLIST (target: empty).
 */
const ALLOWLIST: readonly string[] = [];

const TOOLS_DIR = join(root, "src", "tools");
const AGENT_SRC = readFileSync(join(root, "src", "cli", "agent.ts"), "utf8");

/**
 * The COMMANDS map source only — an Impl referenced solely in an import (or a
 * comment) must not satisfy parity, so registration checks run against this
 * substring instead of the whole file.
 */
function commandsBlock(): string {
  const start = AGENT_SRC.indexOf("const COMMANDS: Record<string, Command> = {");
  if (start === -1) throw new Error("COMMANDS map declaration not found in src/cli/agent.ts");
  const end = AGENT_SRC.indexOf("\n};", start);
  if (end === -1) throw new Error("COMMANDS map closing brace not found in src/cli/agent.ts");
  return AGENT_SRC.slice(start, end);
}
const COMMANDS_SRC = commandsBlock();

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.isFile() && entry.name.endsWith(".ts") ? [full] : [];
  });
}

function exportedImpls(): string[] {
  const names = new Set<string>();
  for (const file of walk(TOOLS_DIR)) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z0-9]+Impl)\b/g)) {
      names.add(match[1] as string);
    }
  }
  return [...names].sort();
}

describe("CLI ↔ tool parity", () => {
  it("wires every exported tool Impl into the agent COMMANDS map", () => {
    const impls = exportedImpls();
    expect(impls.length).toBeGreaterThan(300); // sanity: the scan actually found the tool surface
    const missing = impls.filter(
      (name) => !ALLOWLIST.includes(name) && !new RegExp(`\\b${name}\\b`).test(COMMANDS_SRC),
    );
    expect(missing).toEqual([]);
  });

  it("keeps the MCP-only allowlist honest (no stale entries)", () => {
    const impls = new Set(exportedImpls());
    const stale = ALLOWLIST.filter(
      (name) => !impls.has(name) || new RegExp(`\\b${name}\\b`).test(COMMANDS_SRC),
    );
    expect(stale).toEqual([]);
  });
});
