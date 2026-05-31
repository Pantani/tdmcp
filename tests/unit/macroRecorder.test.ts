import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _resetMacroRecorder,
  getMacroRecorder,
  listMacros,
  MacroRecordSchema,
  readMacro,
  redactArgs,
  summarizeResult,
  writeMacro,
} from "../../src/automation/macroSchema.js";
import { type MacroRecorderArgs, macroRecorderImpl } from "../../src/tools/cli/macroRecorder.js";
import type { ToolContext } from "../../src/tools/types.js";

const ctx = {} as ToolContext;

async function call(args: Partial<MacroRecorderArgs> & { action: MacroRecorderArgs["action"] }) {
  const full: MacroRecorderArgs = { redactSensitive: true, ...args };
  return macroRecorderImpl(ctx, full);
}

let tmp: string;
let prevDir: string | undefined;
let prevVault: string | undefined;

beforeEach(async () => {
  _resetMacroRecorder();
  tmp = await mkdtemp(join(tmpdir(), "tdmcp-macro-"));
  prevDir = process.env.TDMCP_MACROS_DIR;
  prevVault = process.env.TDMCP_VAULT_PATH;
  process.env.TDMCP_MACROS_DIR = tmp;
});

afterEach(() => {
  if (prevDir === undefined) delete process.env.TDMCP_MACROS_DIR;
  else process.env.TDMCP_MACROS_DIR = prevDir;
  if (prevVault === undefined) delete process.env.TDMCP_VAULT_PATH;
  else process.env.TDMCP_VAULT_PATH = prevVault;
});

describe("macro_recorder round-trip", () => {
  it("captures wrapped handler calls, writes a valid record, and round-trips", async () => {
    const start = await call({ action: "start", name: "trip", redactSensitive: true });
    expect(start.isError).toBeFalsy();

    const recorder = getMacroRecorder();
    const h1 = recorder.wrapHandler("create_audio_reactive", async (_a: unknown) => ({
      content: [{ type: "text", text: "built reactive network" }],
    }));
    await h1({ container: "/project1", style: "spectrum" });

    const h2 = recorder.wrapHandler("find_td_nodes", async (_a: unknown) => ({
      content: [{ type: "text", text: "found 3 nodes" }],
    }));
    await h2({ path: "/project1" });

    const h3 = recorder.wrapHandler("create_td_node", async (_a: unknown) => {
      throw new Error("boom");
    });
    await expect(h3({ optype: "constantTOP" })).rejects.toThrow("boom");

    const stop = await call({ action: "stop", name: "trip", redactSensitive: true });
    expect(stop.isError).toBeFalsy();
    const file = join(tmp, "trip.json");
    const record = await readMacro(file);
    expect(MacroRecordSchema.safeParse(record).success).toBe(true);
    expect(record.entries).toHaveLength(3);
    expect(record.entries[0]?.tool).toBe("create_audio_reactive");
    expect(record.entries[2]?.result_summary).toMatch(/^error: boom/);
  });
});

describe("redaction", () => {
  it("redacts execute_python_script.script to length marker", () => {
    const out = redactArgs("execute_python_script", {
      script: "import td\nprint(1)",
      target: "/project1",
    });
    expect(out.script).toBe("[redacted: 18 chars]");
    expect(out.target).toBe("/project1");
  });

  it("redacts vault paths to last two segments", () => {
    process.env.TDMCP_VAULT_PATH = "/Users/x/Vault";
    const out = redactArgs("vault_note", { path: "/Users/x/Vault/Notes/Sub/file.md" });
    expect(out.path).toBe("…/Sub/file.md");
  });

  it("preserves script when redactSensitive=false on the recorder", async () => {
    await call({ action: "start", name: "raw", redactSensitive: false });
    const recorder = getMacroRecorder();
    const h = recorder.wrapHandler("execute_python_script", async () => ({
      content: [{ type: "text", text: "ok" }],
    }));
    await h({ script: "import td\nprint(1)", target: "/project1" });
    await call({ action: "stop", name: "raw", redactSensitive: false });
    const record = await readMacro(join(tmp, "raw.json"));
    expect(record.entries[0]?.args.script).toBe("import td\nprint(1)");
  });
});

describe("control surface", () => {
  it("rejects double-start", async () => {
    await call({ action: "start", name: "first", redactSensitive: true });
    const second = await call({ action: "start", name: "second", redactSensitive: true });
    expect(second.isError).toBe(true);
    const text = second.content?.[0];
    expect(text && "text" in text ? text.text : "").toContain("first");
  });

  it("rejects stop without start", async () => {
    const stop = await call({ action: "stop", name: "x", redactSensitive: true });
    expect(stop.isError).toBe(true);
    const text = stop.content?.[0];
    expect(text && "text" in text ? text.text : "").toContain("no active recording");
  });

  it("list enumerates only .json files", async () => {
    await writeFile(join(tmp, "a.json"), "{}", "utf8");
    await writeFile(join(tmp, "b.txt"), "x", "utf8");
    const r = await call({ action: "list", redactSensitive: true });
    expect(r.isError).toBeFalsy();
    const sc = r.structuredContent as { macros: string[] };
    expect(sc.macros).toEqual(["a.json"]);
  });

  it("load rejects an invalid macro file", async () => {
    const bad = join(tmp, "bad.json");
    await writeFile(bad, JSON.stringify({ name: "x", entries: [] }), "utf8");
    const r = await call({ action: "load", file: bad, redactSensitive: true });
    expect(r.isError).toBe(true);
    const text = r.content?.[0];
    expect(text && "text" in text ? text.text : "").toContain("schema_version");
  });

  it("does not record macro_recorder self-calls", async () => {
    await call({ action: "start", name: "self", redactSensitive: true });
    const recorder = getMacroRecorder();
    const h = recorder.wrapHandler("macro_recorder", async () => ({
      content: [{ type: "text", text: "ok" }],
    }));
    await h({ action: "list" });
    const stop = await call({ action: "stop", name: "self", redactSensitive: true });
    expect(stop.isError).toBeFalsy();
    const record = await readMacro(join(tmp, "self.json"));
    expect(record.entries).toHaveLength(0);
  });

  it("clips long result summaries to a single line ≤240 chars", () => {
    const long = "x".repeat(500) + "\nmore\nlines";
    const out = summarizeResult({ content: [{ type: "text", text: long }] });
    expect(out).toBeDefined();
    expect((out as string).length).toBeLessThanOrEqual(240);
    expect(out as string).not.toMatch(/[\r\n]/);
  });
});

describe("helpers", () => {
  it("writeMacro + listMacros round-trip", async () => {
    await writeMacro(join(tmp, "h.json"), {
      schema_version: 1,
      name: "h",
      created_at: new Date().toISOString(),
      tdmcp_version: "0.0.0",
      entries: [],
    });
    const macros = await listMacros(tmp);
    expect(macros).toContain("h.json");
    const raw = JSON.parse(await readFile(join(tmp, "h.json"), "utf8"));
    expect(raw.schema_version).toBe(1);
  });
});
