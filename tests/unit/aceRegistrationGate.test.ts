import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildToolContext } from "../../src/server/context.js";
import { registerAllTools } from "../../src/tools/index.js";
import type { ToolContext } from "../../src/tools/types.js";
import { type LoadedTdmcpConfig, loadConfig } from "../../src/utils/config.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer } from "../helpers/tdMock.js";

// FIX 4 (Codex P2) — ACE tools are gated by the BUILT context (`ctx.aceClient`),
// NOT by `process.env.TDMCP_ACE_ENABLED` read at module load. The regression this
// guards: enabling ACE via a config file/profile sets `config.aceEnabled` (which
// `buildToolContext` turns into `ctx.aceClient`) WITHOUT any env var, and the
// tools must still register. Conversely, with ACE off, none register.

const mock = makeTdServer();
beforeAll(() => mock.listen({ onUnhandledRequest: "error" }));
afterEach(() => mock.resetHandlers());
afterAll(() => mock.close());

const ACE_TOOL_NAMES = [
  "generate_music",
  "submit_music_job",
  "get_music_job",
  "cancel_music_job",
  "generate_music_reactive",
] as const;

/** Register the full aggregate registry against a throwaway server; capture names. */
function registeredNames(ctx: ToolContext): string[] {
  const server = new McpServer({ name: "tdmcp-ace-gate", version: "0.0.0" });
  const names: string[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: registerTool is overloaded; bind a variadic copy.
  const realRegister = server.registerTool.bind(server) as (...args: any[]) => unknown;
  // biome-ignore lint/suspicious/noExplicitAny: forward the SDK's variadic registerTool signature.
  (server as any).registerTool = (name: string, ...rest: any[]) => {
    names.push(name);
    return realRegister(name, ...rest);
  };
  registerAllTools(server, ctx);
  return names;
}

/** Base env-only config (no ACE), matching the default-off world. */
function baseConfig(): LoadedTdmcpConfig {
  return loadConfig({ TDMCP_RAW_PYTHON: "on" });
}

describe("FIX 4 — ACE tool registration is gated on the built context", () => {
  it("default-off: no ACE tools register when config.aceEnabled is false", () => {
    const ctx = buildToolContext(baseConfig(), { logger: silentLogger });
    const names = registeredNames(ctx);
    for (const name of ACE_TOOL_NAMES) {
      expect(names).not.toContain(name);
    }
  });

  it("config-file path: config.aceEnabled=true (no env) registers all 5 ACE tools", () => {
    // Simulate a config-file/profile flip — NOT an env var. The base config is
    // built without TDMCP_ACE_ENABLED; we set aceEnabled directly, as a loaded
    // config file would, then confirm the tools register off the built context.
    const config: LoadedTdmcpConfig = { ...baseConfig(), aceEnabled: true };
    const ctx = buildToolContext(config, { logger: silentLogger });
    expect(ctx.aceClient).toBeDefined();

    const names = registeredNames(ctx);
    for (const name of ACE_TOOL_NAMES) {
      expect(names).toContain(name);
    }
  });
});
