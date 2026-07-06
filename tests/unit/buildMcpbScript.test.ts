import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = readFileSync(join(root, "scripts", "build-mcpb.mjs"), "utf8");

describe("build-mcpb supply-chain guardrails", () => {
  it("pins official MCPB packer packages instead of resolving mutable npm latest", () => {
    expect(script).toContain("@anthropic-ai/mcpb@2.1.2");
    expect(script).toContain("@anthropic-ai/dxt@0.2.6");
    expect(script).not.toMatch(/pkg:\s*"@anthropic-ai\/(?:mcpb|dxt)"/);
  });

  it("fails closed when production dependency staging fails", () => {
    expect(script).not.toContain('cpSync(join(root, "node_modules")');
    expect(script).not.toMatch(/copying the repo node_modules/i);
    expect(script).toMatch(/prod(?:uction)?-only install failed/i);
  });
});
