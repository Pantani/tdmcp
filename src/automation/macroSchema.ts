/**
 * Macro recorder: captures the sequence of MCP tool calls into a portable
 * `MacroRecord` JSON file. Replay ships in wave 5 as `run_macro_script`.
 *
 * This module exports the schema, a process-local singleton recorder with a
 * `wrapHandler` hook (installed once by the server), redaction helpers, and
 * read/write/list helpers. No TouchDesigner interaction.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { z } from "zod";
import { getVersion } from "../utils/version.js";

export const MacroEntrySchema = z.object({
  tool: z.string().min(1),
  args: z.record(z.string(), z.unknown()),
  ts: z.number().int().nonnegative(),
  result_summary: z.string().optional(),
});

export const MacroRecordSchema = z.object({
  schema_version: z.literal(1),
  name: z.string().min(1),
  created_at: z.iso.datetime(),
  tdmcp_version: z.string().min(1),
  entries: z.array(MacroEntrySchema),
});

export type MacroEntry = z.infer<typeof MacroEntrySchema>;
export type MacroRecord = z.infer<typeof MacroRecordSchema>;

const NAME_RE = /^[A-Za-z0-9_-]+$/;
const SECRET_VALUE = "[redacted]";
const SECRET_KEY_RE =
  /^(api|stream)?key$|^(api|stream)?token$|^auth(orization)?$|^bearer$|^password$|^secret$|^credential(s)?$/;

function normalizeSecretKey(key: string): string {
  return key.toLowerCase().replace(/[-_\s]/g, "");
}

/** Resolve the on-disk macros directory, expanding `~` and `TDMCP_MACROS_DIR`. */
export function resolveMacrosDir(): string {
  const raw = process.env.TDMCP_MACROS_DIR;
  if (raw && raw.length > 0) {
    const expanded = raw.startsWith("~") ? raw.replace(/^~/, homedir()) : raw;
    return resolve(expanded);
  }
  return resolve(process.cwd(), ".tdmcp", "macros");
}

/** Validate `name` (1–80, `[A-Za-z0-9_\-]+`). */
export function isValidMacroName(name: string): boolean {
  return name.length >= 1 && name.length <= 80 && NAME_RE.test(name);
}

function vaultRoot(): string | undefined {
  const v = process.env.TDMCP_VAULT_PATH;
  return v && v.length > 0 ? resolve(v) : undefined;
}

function lastTwoSegments(p: string): string {
  const parts = p.split(/[\\/]/).filter((s) => s.length > 0);
  if (parts.length <= 2) return `…/${parts.join("/")}`;
  return `…/${parts.slice(-2).join("/")}`;
}

function looksLikeVaultPath(value: string): boolean {
  if (value.includes("/.obsidian/")) return true;
  const root = vaultRoot();
  if (root && value.startsWith(root)) return true;
  return false;
}

function redactValue(key: string | undefined, value: unknown): unknown {
  if (typeof value === "string") {
    if (key && value.length > 0 && SECRET_KEY_RE.test(normalizeSecretKey(key))) {
      return SECRET_VALUE;
    }
    if (looksLikeVaultPath(value)) {
      return lastTwoSegments(value);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactValue(undefined, v));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValue(k, v);
    }
    return out;
  }
  return value;
}

/** Redact sensitive fields from a tool's args. Pure — caller owns the clone. */
export function redactArgs(tool: string, args: unknown): Record<string, unknown> {
  const cloned = structuredClone(args ?? {}) as Record<string, unknown>;
  if (tool === "execute_python_script" || tool.endsWith("_python_script")) {
    const script = cloned.script;
    if (typeof script === "string") {
      cloned.script = `[redacted: ${script.length} chars]`;
    }
  }
  return redactValue(undefined, cloned) as Record<string, unknown>;
}

/** Summarize an MCP `CallToolResult`-ish object to a single line ≤240 chars. */
export function summarizeResult(result: unknown): string | undefined {
  if (result === undefined || result === null) return undefined;
  try {
    let text: string | undefined;
    if (typeof result === "object") {
      const r = result as { isError?: boolean; content?: Array<{ type?: string; text?: string }> };
      if (Array.isArray(r.content)) {
        const first = r.content.find((c) => c && c.type === "text" && typeof c.text === "string");
        if (first && typeof first.text === "string") {
          text = first.text.slice(0, 120);
        }
      }
      const prefix = r.isError ? "error: " : "";
      const body = text ?? JSON.stringify(result).slice(0, 200);
      return clipLine(`${prefix}${body}`);
    }
    return clipLine(String(result));
  } catch {
    return undefined;
  }
}

function clipLine(s: string): string {
  const oneLine = s.replace(/[\r\n]+/g, " ").trim();
  return oneLine.length > 240 ? oneLine.slice(0, 240) : oneLine;
}

export interface StartOpts {
  name: string;
  redactSensitive?: boolean;
}

export interface StopResult {
  name: string;
  entryCount: number;
  record: MacroRecord;
}

/** Process-local recording state. One active recording at a time. */
export class MacroRecorder {
  private active = false;
  private name: string | undefined;
  private redact = true;
  private entries: MacroEntry[] = [];
  private createdAt: string | undefined;

  isActive(): boolean {
    return this.active;
  }

  current(): { name: string; entries: number } | undefined {
    if (!this.active || !this.name) return undefined;
    return { name: this.name, entries: this.entries.length };
  }

  start(opts: StartOpts): { ok: true } | { ok: false; error: string } {
    if (this.active) {
      return { ok: false, error: `a macro is already being recorded: ${this.name ?? "?"}` };
    }
    this.active = true;
    this.name = opts.name;
    this.redact = opts.redactSensitive !== false;
    this.entries = [];
    this.createdAt = new Date().toISOString();
    return { ok: true };
  }

  stop(
    opts: { redactSensitive?: boolean } = {},
  ): { ok: true; result: StopResult } | { ok: false; error: string } {
    if (!this.active || !this.name || !this.createdAt) {
      return { ok: false, error: "no active recording" };
    }
    if (opts.redactSensitive !== undefined) {
      this.redact = opts.redactSensitive;
    }
    const record: MacroRecord = {
      schema_version: 1,
      name: this.name,
      created_at: this.createdAt,
      tdmcp_version: getVersion(),
      entries: this.entries,
    };
    const result: StopResult = { name: this.name, entryCount: this.entries.length, record };
    this.active = false;
    this.name = undefined;
    this.entries = [];
    this.createdAt = undefined;
    return { ok: true, result };
  }

  /** Wrap a tool handler so its invocation is recorded when active. */
  wrapHandler<A, R>(
    toolName: string,
    handler: (args: A) => Promise<R> | R,
  ): (args: A) => Promise<R> {
    return async (args: A): Promise<R> => {
      if (!this.active || toolName === "macro_recorder") {
        return await handler(args);
      }
      const snapshot = this.redact
        ? redactArgs(toolName, args)
        : (structuredClone(args ?? {}) as Record<string, unknown>);
      const ts = Date.now();
      try {
        const result = await handler(args);
        if (this.active) {
          this.entries.push({
            tool: toolName,
            args: snapshot,
            ts,
            result_summary: summarizeResult(result),
          });
        }
        return result;
      } catch (err) {
        if (this.active) {
          const msg = err instanceof Error ? err.message : String(err);
          this.entries.push({
            tool: toolName,
            args: snapshot,
            ts,
            result_summary: clipLine(`error: ${msg}`),
          });
        }
        throw err;
      }
    };
  }
}

let recorderSingleton: MacroRecorder | undefined;

export function getMacroRecorder(): MacroRecorder {
  if (!recorderSingleton) recorderSingleton = new MacroRecorder();
  return recorderSingleton;
}

/** Test-only: reset the singleton between cases. */
export function _resetMacroRecorder(): void {
  recorderSingleton = new MacroRecorder();
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function writeMacro(file: string, record: MacroRecord): Promise<void> {
  await ensureDir(dirname(file));
  await writeFile(file, JSON.stringify(record, null, 2), "utf8");
}

export async function readMacro(file: string): Promise<MacroRecord> {
  const raw = await readFile(file, "utf8");
  const parsed = JSON.parse(raw);
  return MacroRecordSchema.parse(parsed);
}

export async function listMacros(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".json"))
      .map((e) => e.name)
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/** Resolve a possibly-relative `file` arg against the macros dir. */
export function resolveMacroFile(file: string, dir: string): string {
  if (isAbsolute(file)) return file;
  // also accept bare names without .json
  const withExt = file.endsWith(".json") ? file : `${file}.json`;
  return resolve(dir, withExt);
}

/** Default macro path from name + dir. */
export function defaultMacroFile(name: string, dir: string): string {
  return `${dir}${sep}${name}.json`;
}
