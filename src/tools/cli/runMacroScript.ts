/**
 * `run_macro_script` — replay a `MacroRecord` JSON file by dispatching each
 * recorded entry through the in-process tool handlers. Supports dryRun,
 * per-tool argsOverrides, stopOnError, and refuses raw-Python entries when
 * `ctx.allowRawPython === false`.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  readMacro,
  resolveMacroFile,
  resolveMacrosDir,
  summarizeResult,
} from "../../automation/macroSchema.js";
import { registerToolRegistrars, runtimeToolRegistrars } from "../registry.js";
import { errorResult, structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { registerMacroRecorder } from "./macroRecorder.js";

export const runMacroScriptSchema = z.object({
  macroPath: z.string().min(1),
  dryRun: z.boolean().default(false),
  allowRawPython: z.boolean().default(false),
  stopOnError: z.boolean().default(true),
  argsOverrides: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
});

export type RunMacroScriptArgs = z.infer<typeof runMacroScriptSchema>;

type Handler = (args: unknown) => Promise<CallToolResult> | CallToolResult;
type HandlerMap = Map<string, Handler>;

const cachedHandlers = new WeakMap<ToolContext, HandlerMap>();
const injectedHandlers = new WeakMap<ToolContext, HandlerMap>();
const SENTINEL_CTX: ToolContext = {} as ToolContext;

/** Test-only: inject a handler registry instead of building one from the tool registrars. */
export function __setHandlersForTests(
  handlers: HandlerMap | undefined,
  ctx: ToolContext = SENTINEL_CTX,
): void {
  if (handlers === undefined) {
    injectedHandlers.delete(ctx);
  } else {
    injectedHandlers.set(ctx, handlers);
  }
  cachedHandlers.delete(ctx);
}

async function getOrBuildToolHandlers(ctx: ToolContext): Promise<HandlerMap> {
  const injectedCtx = injectedHandlers.get(ctx) ?? injectedHandlers.get(SENTINEL_CTX);
  if (injectedCtx) return injectedCtx;
  const cached = cachedHandlers.get(ctx);
  if (cached) return cached;
  const map: HandlerMap = new Map();
  // Stub MCP server that captures only registerTool(name, _meta, handler).
  const stub = {
    registerTool: (name: string, _meta: unknown, handler: Handler) => {
      map.set(name, handler);
      return undefined;
    },
  } as unknown as McpServer;
  registerToolRegistrars(stub, ctx, [
    ...runtimeToolRegistrars,
    registerMacroRecorder,
    registerRunMacroScript,
  ]);
  cachedHandlers.set(ctx, map);
  return map;
}

export function isRawPythonTool(tool: string): boolean {
  return (
    tool === "execute_python_script" ||
    tool.endsWith("_python_script") ||
    tool === "exec_node_method"
  );
}

interface EntryReport {
  index: number;
  tool: string;
  ok: boolean;
  skipped?: "raw-python-blocked" | "unknown-tool";
  summary?: string;
  ms?: number;
}

export async function runMacroScriptImpl(
  ctx: ToolContext,
  args: RunMacroScriptArgs,
): Promise<CallToolResult> {
  const dir = resolveMacrosDir();
  const file = resolveMacroFile(args.macroPath, dir);

  let record: Awaited<ReturnType<typeof readMacro>>;
  try {
    record = await readMacro(file);
  } catch (err) {
    if (err && typeof err === "object" && "issues" in err) {
      const issues = (err as { issues: Array<{ path: (string | number)[]; message: string }> })
        .issues;
      const summary = issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ");
      return errorResult(`invalid macro file: ${summary}`);
    }
    const msg = err instanceof Error ? err.message : String(err);
    return errorResult(`failed to load macro: ${msg}`);
  }

  const total = record.entries.length;

  if (args.dryRun) {
    const entries: EntryReport[] = record.entries.map((e, i) => ({
      index: i,
      tool: e.tool,
      ok: true,
    }));
    return structuredResult(`dry-run: ${total} entries planned for ${record.name}`, {
      status: "dry-run",
      name: record.name,
      total,
      ran: 0,
      ok: 0,
      failed: 0,
      skipped: 0,
      entries,
    });
  }

  const handlers = await getOrBuildToolHandlers(ctx);
  const overrides = args.argsOverrides ?? {};
  const report: EntryReport[] = [];
  let ran = 0;
  let okCount = 0;
  let failed = 0;
  let skipped = 0;
  let halted = false;

  for (let i = 0; i < record.entries.length; i++) {
    // biome-ignore lint/style/noNonNullAssertion: loop bounded by length.
    const entry = record.entries[i]!;

    if (
      isRawPythonTool(entry.tool) &&
      (ctx.allowRawPython === false || args.allowRawPython !== true)
    ) {
      report.push({ index: i, tool: entry.tool, ok: false, skipped: "raw-python-blocked" });
      skipped++;
      if (args.stopOnError) {
        halted = true;
        break;
      }
      continue;
    }

    const handler = handlers.get(entry.tool);
    if (!handler) {
      report.push({ index: i, tool: entry.tool, ok: false, skipped: "unknown-tool" });
      skipped++;
      if (args.stopOnError) {
        halted = true;
        break;
      }
      continue;
    }

    const override = overrides[entry.tool];
    const mergedArgs = override ? { ...entry.args, ...override } : entry.args;
    const t0 = Date.now();
    try {
      const res = await handler(mergedArgs);
      const ms = Date.now() - t0;
      const isErr = res.isError === true;
      report.push({
        index: i,
        tool: entry.tool,
        ok: !isErr,
        summary: summarizeResult(res),
        ms,
      });
      ran++;
      if (isErr) {
        failed++;
        if (args.stopOnError) {
          halted = true;
          break;
        }
      } else {
        okCount++;
      }
    } catch (err) {
      const ms = Date.now() - t0;
      const msg = err instanceof Error ? err.message : String(err);
      report.push({
        index: i,
        tool: entry.tool,
        ok: false,
        summary: `error: ${msg}`.slice(0, 240),
        ms,
      });
      ran++;
      failed++;
      if (args.stopOnError) {
        halted = true;
        break;
      }
    }
  }

  const status = halted ? "halted" : "replayed";
  return structuredResult(
    `${status}: ${okCount}/${total} ok, ${failed} failed, ${skipped} skipped (${record.name})`,
    {
      status,
      name: record.name,
      total,
      ran,
      ok: okCount,
      failed,
      skipped,
      entries: report,
    },
  );
}

export const registerRunMacroScript: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "run_macro_script",
    {
      title: "Run macro script",
      description:
        "Replay a `MacroRecord` JSON file by dispatching each entry through the in-process tool handlers. Use `dryRun` to plan without invoking, `stopOnError` to halt on first failure, `argsOverrides` to shallow-merge per-tool arg replacements, and `allowRawPython` to opt-in to raw-Python entries (still subject to the server-side ctx gate). Redacted args from a recording may fail at the tool boundary; do not un-redact.",
      inputSchema: runMacroScriptSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => runMacroScriptImpl(ctx, args),
  );
};
