import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeMacro } from "../../src/automation/macroSchema.js";
import {
  __setHandlersForTests,
  isRawPythonTool,
  type RunMacroScriptArgs,
  runMacroScriptImpl,
} from "../../src/tools/cli/runMacroScript.js";
import type { ToolContext } from "../../src/tools/types.js";

type Handler = (args: unknown) => Promise<CallToolResult> | CallToolResult;

const baseCtx = {} as ToolContext;

function makeArgs(over: Partial<RunMacroScriptArgs>): RunMacroScriptArgs {
  return {
    macroPath: over.macroPath ?? "missing",
    dryRun: over.dryRun ?? false,
    allowRawPython: over.allowRawPython ?? false,
    stopOnError: over.stopOnError ?? true,
    argsOverrides: over.argsOverrides,
  };
}

async function writeRecord(
  file: string,
  entries: Array<{ tool: string; args?: Record<string, unknown> }>,
) {
  await writeMacro(file, {
    schema_version: 1,
    name: "test",
    created_at: new Date().toISOString(),
    tdmcp_version: "0.0.0",
    entries: entries.map((e, i) => ({ tool: e.tool, args: e.args ?? {}, ts: 1_000 + i })),
  });
}

let tmp: string;
let prevDir: string | undefined;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "tdmcp-runmacro-"));
  prevDir = process.env.TDMCP_MACROS_DIR;
  process.env.TDMCP_MACROS_DIR = tmp;
});

afterEach(() => {
  __setHandlersForTests(undefined);
  if (prevDir === undefined) delete process.env.TDMCP_MACROS_DIR;
  else process.env.TDMCP_MACROS_DIR = prevDir;
});

describe("runMacroScriptImpl", () => {
  it("returns errorResult on schema-invalid macro", async () => {
    const file = join(tmp, "bad.json");
    await writeFile(file, JSON.stringify({ name: "x", entries: [] }), "utf8");
    const r = await runMacroScriptImpl(baseCtx, makeArgs({ macroPath: file }));
    expect(r.isError).toBe(true);
    const c = r.content?.[0];
    expect(c && "text" in c ? c.text : "").toContain("invalid macro file:");
  });

  it("dryRun lists entries and never invokes handlers", async () => {
    const file = join(tmp, "plan.json");
    await writeRecord(file, [{ tool: "find_td_nodes" }, { tool: "create_td_node" }]);
    const spy = vi.fn();
    __setHandlersForTests(new Map<string, Handler>([["find_td_nodes", spy]]));
    const r = await runMacroScriptImpl(baseCtx, makeArgs({ macroPath: file, dryRun: true }));
    expect(r.isError).toBeFalsy();
    expect(spy).not.toHaveBeenCalled();
    const sc = r.structuredContent as {
      status: string;
      ran: number;
      total: number;
      entries: Array<{ index: number; tool: string }>;
    };
    expect(sc.status).toBe("dry-run");
    expect(sc.ran).toBe(0);
    expect(sc.total).toBe(2);
    expect(sc.entries.map((e) => e.tool)).toEqual(["find_td_nodes", "create_td_node"]);
  });

  it("marks unknown tool entries as skipped and continues with stopOnError=false", async () => {
    const file = join(tmp, "unk.json");
    await writeRecord(file, [{ tool: "nope_tool" }, { tool: "known_tool" }]);
    const known = vi.fn(
      async () => ({ content: [{ type: "text", text: "ok" }] }) as CallToolResult,
    );
    __setHandlersForTests(new Map<string, Handler>([["known_tool", known]]));
    const r = await runMacroScriptImpl(baseCtx, makeArgs({ macroPath: file, stopOnError: false }));
    const sc = r.structuredContent as {
      status: string;
      skipped: number;
      ok: number;
      entries: Array<{ skipped?: string; ok: boolean }>;
    };
    expect(sc.status).toBe("replayed");
    expect(sc.skipped).toBe(1);
    expect(sc.ok).toBe(1);
    expect(sc.entries[0]?.skipped).toBe("unknown-tool");
    expect(known).toHaveBeenCalledOnce();
  });

  it("refuses raw-Python entries when ctx.allowRawPython === false", async () => {
    const file = join(tmp, "py.json");
    await writeRecord(file, [{ tool: "execute_python_script", args: { script: "x" } }]);
    const spy = vi.fn();
    __setHandlersForTests(new Map<string, Handler>([["execute_python_script", spy]]));
    const ctx = { allowRawPython: false } as ToolContext;
    const r = await runMacroScriptImpl(ctx, makeArgs({ macroPath: file, stopOnError: false }));
    expect(spy).not.toHaveBeenCalled();
    const sc = r.structuredContent as { entries: Array<{ skipped?: string }>; skipped: number };
    expect(sc.entries[0]?.skipped).toBe("raw-python-blocked");
    expect(sc.skipped).toBe(1);
  });

  it("requires per-replay opt-in for author_script_operator", async () => {
    const file = join(tmp, "author-script.json");
    await writeRecord(file, [{ tool: "author_script_operator", args: { callbacks: {} } }]);
    const spy = vi.fn();
    __setHandlersForTests(new Map<string, Handler>([["author_script_operator", spy]]));

    const result = await runMacroScriptImpl(
      { allowRawPython: true } as ToolContext,
      makeArgs({ macroPath: file, stopOnError: false }),
    );

    expect(spy).not.toHaveBeenCalled();
    const structured = result.structuredContent as {
      entries: Array<{ skipped?: string }>;
      skipped: number;
    };
    expect(structured.entries[0]?.skipped).toBe("raw-python-blocked");
    expect(structured.skipped).toBe(1);
  });

  it("calls raw-Python handler when caller opts in via args.allowRawPython=true", async () => {
    const file = join(tmp, "py-ok.json");
    await writeRecord(file, [{ tool: "execute_python_script", args: { script: "x" } }]);
    const spy = vi.fn(async () => ({ content: [{ type: "text", text: "ran" }] }) as CallToolResult);
    __setHandlersForTests(new Map<string, Handler>([["execute_python_script", spy]]));
    const r = await runMacroScriptImpl(
      baseCtx,
      makeArgs({ macroPath: file, allowRawPython: true }),
    );
    expect(spy).toHaveBeenCalledOnce();
    const sc = r.structuredContent as { ok: number; failed: number };
    expect(sc.ok).toBe(1);
    expect(sc.failed).toBe(0);
  });

  it("happy path: dispatches in order, ms numeric", async () => {
    const file = join(tmp, "ok.json");
    await writeRecord(file, [{ tool: "a" }, { tool: "b" }, { tool: "c" }]);
    const calls: string[] = [];
    const mkH =
      (n: string): Handler =>
      async () => {
        calls.push(n);
        return { content: [{ type: "text", text: n }] };
      };
    __setHandlersForTests(
      new Map<string, Handler>([
        ["a", mkH("a")],
        ["b", mkH("b")],
        ["c", mkH("c")],
      ]),
    );
    const r = await runMacroScriptImpl(baseCtx, makeArgs({ macroPath: file }));
    const sc = r.structuredContent as {
      ok: number;
      failed: number;
      entries: Array<{ tool: string; ms?: number }>;
    };
    expect(sc.ok).toBe(3);
    expect(sc.failed).toBe(0);
    expect(calls).toEqual(["a", "b", "c"]);
    expect(typeof sc.entries[0]?.ms).toBe("number");
  });

  it("stopOnError=true halts after first isError", async () => {
    const file = join(tmp, "halt.json");
    await writeRecord(file, [{ tool: "a" }, { tool: "b" }, { tool: "c" }]);
    const cSpy = vi.fn();
    __setHandlersForTests(
      new Map<string, Handler>([
        ["a", async () => ({ content: [{ type: "text", text: "ok" }] })],
        ["b", async () => ({ isError: true, content: [{ type: "text", text: "bad" }] })],
        ["c", cSpy],
      ]),
    );
    const r = await runMacroScriptImpl(baseCtx, makeArgs({ macroPath: file, stopOnError: true }));
    const sc = r.structuredContent as { status: string; failed: number; ran: number };
    expect(sc.status).toBe("halted");
    expect(sc.failed).toBe(1);
    expect(sc.ran).toBe(2);
    expect(cSpy).not.toHaveBeenCalled();
  });

  it("argsOverrides shallow-merges over entry args (override wins)", async () => {
    const file = join(tmp, "ov.json");
    await writeRecord(file, [{ tool: "t", args: { a: 1, b: 2 } }]);
    let seen: Record<string, unknown> | undefined;
    __setHandlersForTests(
      new Map<string, Handler>([
        [
          "t",
          async (args: unknown) => {
            seen = args as Record<string, unknown>;
            return { content: [{ type: "text", text: "ok" }] };
          },
        ],
      ]),
    );
    await runMacroScriptImpl(
      baseCtx,
      makeArgs({ macroPath: file, argsOverrides: { t: { b: 99, c: 3 } } }),
    );
    expect(seen).toEqual({ a: 1, b: 99, c: 3 });
  });

  it("resolveMacroFile parity: bare name resolves against TDMCP_MACROS_DIR", async () => {
    await writeRecord(join(tmp, "foo.json"), [{ tool: "x" }]);
    __setHandlersForTests(
      new Map<string, Handler>([["x", async () => ({ content: [{ type: "text", text: "ok" }] })]]),
    );
    const r = await runMacroScriptImpl(baseCtx, makeArgs({ macroPath: "foo" }));
    const sc = r.structuredContent as { ok: number };
    expect(sc.ok).toBe(1);
  });

  it("isRawPythonTool covers documented names", () => {
    expect(isRawPythonTool("execute_python_script")).toBe(true);
    expect(isRawPythonTool("create_python_script")).toBe(true);
    expect(isRawPythonTool("exec_node_method")).toBe(true);
    expect(isRawPythonTool("author_script_operator")).toBe(true);
    expect(isRawPythonTool("find_td_nodes")).toBe(false);
  });
});
