import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildToolContext } from "../../src/server/context.js";
import { layer1Registrars } from "../../src/tools/layer1/index.js";
import { layer2Registrars } from "../../src/tools/layer2/index.js";
import { registerToolRegistrars } from "../../src/tools/registry.js";
import type { ToolContext, ToolRegistrar } from "../../src/tools/types.js";
import { loadConfig } from "../../src/utils/config.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer } from "../helpers/tdMock.js";

// G4 — Bridge hardening (ledger item `g4_exec_off_ci_smoke`).
//
// Proves that EVERY Layer-1 + Layer-2 tool registers/builds when raw Python
// exec is disabled at the SERVER layer — i.e. no tool throws at registration
// time, and the exec-only escape hatches stay hidden, when the venue turns
// exec off.
//
// Two distinct "exec off" switches exist; this smoke runs against the FIRST:
//
//   1. TDMCP_RAW_PYTHON=off  → Node server side. Parsed in src/utils/config.ts
//      into `config.rawPython`, which buildToolContext turns into
//      `allowRawPython: config.rawPython !== "off"` (src/server/context.ts).
//      When false, the raw-Python registrars (create_python_script in Layer 2;
//      execute_python_script / exec_node_method in Layer 3) early-return and
//      never register their tool. THIS is what the smoke exercises.
//
//   2. TDMCP_BRIDGE_ALLOW_EXEC=0 → TD/bridge side env (documented in the
//      ROADMAP / architecture). It refuses `/api/exec` INSIDE TouchDesigner.
//      It is orthogonal to (1): (1) hides the tools from the MCP surface;
//      (2) makes the bridge reject exec even if a tool tried it. The smoke
//      asserts the Node-layer contract (1); the bridge is msw-mocked here.
//
// The bridge is mocked with msw (no TouchDesigner needed), so this runs
// anywhere CI runs.

const mock = makeTdServer();
beforeAll(() => mock.listen({ onUnhandledRequest: "error" }));
afterEach(() => mock.resetHandlers());
afterAll(() => mock.close());

/** The only Layer-1/Layer-2 tool gated by `allowRawPython` (raw client-authored
 * Python stored in a DAT). Must be ABSENT when exec is off. The other two raw
 * tools (execute_python_script, exec_node_method) live in Layer 3, out of this
 * smoke's Layer-1/2 scope but reported in the campaign notes. */
const LAYER12_EXEC_ONLY = ["create_python_script", "author_script_operator"] as const;

/** A representative slice of ordinary build tools that MUST stay available with
 * exec off — they don't depend on raw Python and must register cleanly. */
const MUST_REGISTER = [
  // Layer 1 — whole-network artist tools
  "create_feedback_network",
  "create_audio_reactive",
  "create_particle_system",
  "apply_recipe",
  // Layer 2 — building blocks
  "create_node_chain",
  "connect_nodes",
  "create_control_panel",
  "animate_parameter",
] as const;

/**
 * Registers the given registrars against a real McpServer, recording every
 * registered tool name and surfacing any error thrown during registration as a
 * failed assertion (so a hard-required-exec tool can't pass silently).
 */
function registerAndCollect(
  ctx: ToolContext,
  registrars: readonly ToolRegistrar[],
): { names: string[]; failures: Array<{ name: string; error: unknown }> } {
  const server = new McpServer({ name: "tdmcp-execoff-smoke", version: "0.0.0" });
  const names: string[] = [];
  const failures: Array<{ name: string; error: unknown }> = [];

  // Wrap registerTool to record names and trap per-tool failures without
  // aborting the whole sweep — we want to know EVERY tool that hard-requires
  // exec at construction, not just the first.
  // biome-ignore lint/suspicious/noExplicitAny: registerTool is overloaded; bind a variadic copy to forward args.
  const realRegister = server.registerTool.bind(server) as (...args: any[]) => unknown;
  // biome-ignore lint/suspicious/noExplicitAny: forwarding the SDK's variadic registerTool signature.
  (server as any).registerTool = (name: string, ...rest: any[]) => {
    names.push(name);
    try {
      return realRegister(name, ...rest);
    } catch (error) {
      failures.push({ name, error });
      return undefined;
    }
  };

  // registerToolRegistrars is the same code path the server uses; a registrar
  // that throws BEFORE calling registerTool (e.g. touching ctx.client eagerly)
  // would escape here, which is itself a finding — so we let it propagate.
  registerToolRegistrars(server, ctx, registrars);
  return { names, failures };
}

function execOffContext(): ToolContext {
  // Canonical path: TDMCP_RAW_PYTHON=off → config.rawPython="off" →
  // allowRawPython=false. Defaults point the client at 127.0.0.1:9980, which
  // the msw mock serves.
  const config = loadConfig({ TDMCP_RAW_PYTHON: "off" });
  const ctx = buildToolContext(config, { logger: silentLogger });
  // Guard the precondition: the whole smoke is meaningless if exec is on.
  expect(ctx.allowRawPython).toBe(false);
  return ctx;
}

const LAYER12 = [...layer1Registrars, ...layer2Registrars];

describe("smoke: Layer-1 + Layer-2 register with raw exec OFF", () => {
  it("registers every Layer-1/Layer-2 tool without throwing", () => {
    const ctx = execOffContext();
    const { names, failures } = registerAndCollect(ctx, LAYER12);

    // No tool may throw at registration/build time when exec is disabled.
    expect(failures).toEqual([]);
    // Sanity: we actually exercised a meaningful number of tools.
    expect(names.length).toBeGreaterThan(100);
  });

  it("hides the Layer-1/Layer-2 exec-only tools", () => {
    const ctx = execOffContext();
    const { names } = registerAndCollect(ctx, LAYER12);
    for (const exec of LAYER12_EXEC_ONLY) {
      expect(names).not.toContain(exec);
    }
  });

  it("keeps the ordinary build/connect surface available", () => {
    const ctx = execOffContext();
    const { names } = registerAndCollect(ctx, LAYER12);
    expect(names).toEqual(expect.arrayContaining([...MUST_REGISTER]));
  });

  it("turning exec back on re-adds exactly the exec-only Layer-1/2 tools", () => {
    // Control run: with exec enabled, the gated registrars register again, and
    // the ONLY delta vs. exec-off is the exec-only set — proving the smoke's
    // absence assertion is caused by the gate, not by an unrelated skip.
    const onCtx = buildToolContext(loadConfig({ TDMCP_RAW_PYTHON: "on" }), {
      logger: silentLogger,
    });
    expect(onCtx.allowRawPython).toBe(true);

    const off = new Set(registerAndCollect(execOffContext(), LAYER12).names);
    const on = new Set(registerAndCollect(onCtx, LAYER12).names);

    const onlyWhenExecOn = [...on].filter((n) => !off.has(n)).sort();
    expect(onlyWhenExecOn).toEqual([...LAYER12_EXEC_ONLY].sort());
  });
});
