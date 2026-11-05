import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import { registerToolRegistrars } from "../../src/tools/registry.js";
import type { ToolContext, ToolRegistrar } from "../../src/tools/types.js";
import type { BridgeCall, makeExecOffBridge } from "./execOffBridge.js";
import { minimalToolArgs } from "./minimalToolArgs.js";

/**
 * What a tool did against an exec-off bridge, on its DEFAULT path only.
 *
 * - `clean`: no refusal; every bridge call was a route that survives exec-off.
 * - `placement_only`: only the cosmetic node-placement scripts were refused; the
 *   network is requested in full, but nodes may overlap at the origin.
 * - `degraded`: real work was refused, yet the tool returned success. The result
 *   is partial, usually with a warning: the "fail-forward" path.
 * - `blocked`: real work was refused and the tool returned an error.
 * - `unverified`: the smoke could not judge it (no valid minimal args, a mock gap,
 *   or an error unrelated to any refusal). This says nothing either way.
 */
export type ExecOffStatus = "clean" | "placement_only" | "degraded" | "blocked" | "unverified";

export interface ToolOutcome {
  tool: string;
  status: ExecOffStatus;
  gates: string[];
  detail?: string;
}

interface CapturedTool {
  name: string;
  inputSchema?: z.ZodRawShape;
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<CallToolResult>;
}

/** Collects every tool handler the registrars register, via the server's code path. */
export function captureTools(ctx: ToolContext, registrars: readonly ToolRegistrar[]) {
  const server = new McpServer({ name: "tdmcp-exec-off-sweep", version: "0.0.0" });
  const tools: CapturedTool[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: forwarding the SDK's variadic registerTool signature.
  (server as any).registerTool = (name: string, config: any, handler: any) => {
    tools.push({ name, inputSchema: config?.inputSchema, handler });
    return undefined;
  };
  registerToolRegistrars(server, ctx, registrars);
  return tools;
}

const PLACEMENT_SCRIPT = /^_pos = \{|^_parent = op\(.*\n_new = op\(/;

/** Exec-off outcomes from most to least capable. A tool may only move left. */
export const STATUS_RANK: Record<ExecOffStatus, number> = {
  clean: 0,
  placement_only: 1,
  degraded: 2,
  blocked: 3,
  unverified: 4,
};

/** True for the two cosmetic scripts from `src/tools/layout.ts`, and nothing else. */
export function isPlacementScript(script: string | undefined): boolean {
  return script !== undefined && PLACEMENT_SCRIPT.test(script);
}

function classify(calls: BridgeCall[], result: CallToolResult): Omit<ToolOutcome, "tool"> {
  const refused = calls.filter((call) => call.gate);
  const substantive = refused.filter((call) => !isPlacementScript(call.script));
  const gatesOf = (list: BridgeCall[]) => [...new Set(list.map((c) => c.gate as string))].sort();
  const gates = gatesOf(substantive);
  const text = result.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n")
    .slice(0, 300);

  if (result.isError && substantive.length > 0) return { status: "blocked", gates, detail: text };
  // A tool whose whole job is placement (arrange_network) fails on the "cosmetic" script.
  if (result.isError && refused.length > 0 && text.includes("TDMCP_BRIDGE_ALLOW_EXEC")) {
    return { status: "blocked", gates: gatesOf(refused), detail: text };
  }
  if (calls.some((call) => call.mockGap)) {
    const gaps = calls.filter((c) => c.mockGap).map((c) => `${c.method} ${c.path}`);
    return { status: "unverified", gates, detail: `mock gap: ${gaps.join(", ")}` };
  }
  if (result.isError) return { status: "unverified", gates, detail: text };
  if (substantive.length > 0) return { status: "degraded", gates };
  if (refused.length > 0) return { status: "placement_only", gates: [] };
  return { status: "clean", gates: [] };
}

const TOOL_TIMEOUT_MS = 10_000;

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Runs one tool on its default path and classifies how exec-off treated it. */
export async function sweepTool(
  tool: CapturedTool,
  bridge: ReturnType<typeof makeExecOffBridge>,
  overrides: Record<string, unknown> | undefined,
): Promise<ToolOutcome> {
  bridge.takeCalls();
  const built = minimalToolArgs(tool.inputSchema, overrides);
  if (!built.ok) {
    return {
      tool: tool.name,
      status: "unverified",
      gates: [],
      detail: `no valid minimal args: ${built.issues.join("; ")}`,
    };
  }
  const extra = {
    signal: new AbortController().signal,
    requestId: `exec-off-${tool.name}`,
    sendNotification: async () => undefined,
    sendRequest: async () => {
      throw new Error("exec-off smoke has no MCP client");
    },
  };
  try {
    const result = await withTimeout(tool.handler(built.args, extra), TOOL_TIMEOUT_MS);
    return { tool: tool.name, ...classify(bridge.takeCalls(), result) };
  } catch (err) {
    // Handlers must never throw; a throw is a finding of its own, but not an exec one
    // unless a refusal caused it.
    const calls = bridge.takeCalls();
    const message = err instanceof Error ? err.message : String(err);
    return {
      tool: tool.name,
      ...classify(calls, {
        isError: true,
        content: [{ type: "text", text: `THROWN: ${message}` }],
      }),
    };
  }
}
