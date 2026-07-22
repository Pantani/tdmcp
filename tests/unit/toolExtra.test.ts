import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildToolContext } from "../../src/server/context.js";
import { registerAllTools } from "../../src/tools/index.js";
import type { ToolContext, ToolExtra } from "../../src/tools/types.js";
import { loadConfig } from "../../src/utils/config.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer } from "../helpers/tdMock.js";

// P2 / F4 — `ToolExtra` type plumbing.
//
// F4 adds ONE exported type alias to src/tools/types.ts. Nothing else changes:
// the MCP SDK already passes `extra` as the 2nd argument to every registrar
// callback at runtime; our arrows simply don't name it, and TS allows the
// lower arity. This file is the regression gate that proves it:
//   1. the aggregate registry still registers the exact same tool surface;
//   2. calling a legacy 1-arity callback with (args, extra) is inert;
//   3. ToolExtra is structurally what the SDK hands over.

const mock = makeTdServer();
beforeAll(() => mock.listen({ onUnhandledRequest: "error" }));
afterEach(() => mock.resetHandlers());
afterAll(() => mock.close());

type ToolCallback = (args: Record<string, unknown>, extra?: unknown) => unknown;

/** Registers the full aggregate tool registry, capturing every name + callback. */
function registerAll(ctx: ToolContext): { names: string[]; callbacks: Map<string, ToolCallback> } {
  const server = new McpServer({ name: "tdmcp-toolextra", version: "0.0.0" });
  const names: string[] = [];
  const callbacks = new Map<string, ToolCallback>();

  // biome-ignore lint/suspicious/noExplicitAny: registerTool is overloaded; bind a variadic copy to forward args.
  const realRegister = server.registerTool.bind(server) as (...args: any[]) => unknown;
  // biome-ignore lint/suspicious/noExplicitAny: forwarding the SDK's variadic registerTool signature.
  (server as any).registerTool = (name: string, ...rest: any[]) => {
    names.push(name);
    const cb = rest[rest.length - 1];
    if (typeof cb === "function") callbacks.set(name, cb as ToolCallback);
    return realRegister(name, ...rest);
  };

  registerAllTools(server, ctx);
  return { names, callbacks };
}

function fullContext(): ToolContext {
  return buildToolContext(loadConfig({ TDMCP_RAW_PYTHON: "on" }), { logger: silentLogger });
}

/** A stand-in for what the SDK hands a callback — structurally a `ToolExtra`. */
function fakeExtra(): ToolExtra {
  return {
    signal: new AbortController().signal,
    requestId: 42,
    sendNotification: async () => {},
    sendRequest: async () => ({}) as never,
    _meta: { progressToken: "tok-1" },
  } as unknown as ToolExtra;
}

describe("F4 — ToolExtra plumbing is additive and inert", () => {
  it("registers the whole tool surface with unique names (registry parity gate)", () => {
    const { names } = registerAll(fullContext());

    expect(new Set(names).size).toBe(names.length); // no duplicates
    expect(names.length).toBeGreaterThan(300); // sanity: the real registry, not a stub
    expect([...names].sort()).toMatchSnapshot("all-registered-tool-names");
  });

  it("registers the same surface whether or not ToolExtra exists (no drop-out)", () => {
    const a = registerAll(fullContext()).names.sort();
    const b = registerAll(fullContext()).names.sort();
    expect(a).toEqual(b);
    expect(a).toEqual(expect.arrayContaining(["create_td_node", "connect_nodes", "apply_recipe"]));
  });

  it("passing `extra` to an untouched 1-arity registrar callback is inert", async () => {
    const { callbacks } = registerAll(fullContext());
    const cb = callbacks.get("create_td_node");
    expect(cb).toBeDefined();
    if (!cb) return;

    const args = { type: "noiseTOP", name: "f4_probe", parent_path: "/project1" };
    const one = await cb({ ...args });
    const two = await cb({ ...args }, fakeExtra());

    // The legacy arrow never names its 2nd parameter, so the extra is dropped:
    // both invocations must produce the same result shape.
    expect(two).toEqual(one);
  });

  it("ToolExtra is structurally what the SDK hands over", () => {
    const extra = fakeExtra();
    expect(extra.signal).toBeInstanceOf(AbortSignal);
    expect(extra.requestId).toBe(42);
    expect(typeof extra.sendNotification).toBe("function");
    expect(typeof extra.sendRequest).toBe("function");
    expect(extra._meta?.progressToken).toBe("tok-1");
  });
});
