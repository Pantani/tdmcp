/**
 * Local build log: one JSONL record per finished network build, written by
 * `finalize` so past work can later be retrieved (the Project RAG corpus).
 *
 * Rules:
 * - Local only. Nothing here touches the network or the bridge.
 * - Never fails a build: every error is logged at debug level and swallowed.
 * - Arguments and parameters are redacted and bounded before they reach disk.
 *
 * Opt out with `TDMCP_BUILD_LOG=off`. Default location: `~/.tdmcp/builds/`.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { appendFile, chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { redactArgs } from "../automation/macroSchema.js";
import { atomicWriteFileSync } from "../utils/atomicWrite.js";
import type { Logger } from "../utils/logger.js";

export const BUILD_LOG_SCHEMA_VERSION = 1;
export const DEFAULT_BUILD_LOG_MAX_RECORDS = 1000;

const LOG_FILE = "builds.jsonl";
const PREVIEW_DIR = "previews";
const MAX_STRING_CHARS = 2000;
const MAX_MESSAGE_CHARS = 500;
const MAX_ARRAY_ITEMS = 200;
const MAX_DEPTH = 8;
const MAX_NODES = 500;
const MAX_EDGES = 1000;
const MAX_MESSAGES = 50;
/** Roughly a 3 MB image once decoded; anything larger is not worth keeping per build. */
const MAX_PREVIEW_BASE64_CHARS = 4_000_000;

export interface BuiltNode {
  name: string;
  path: string;
  type: string;
  parameters?: Record<string, unknown>;
}

export interface BuiltEdge {
  from: string;
  to: string;
}

export interface BuildRecordInput {
  summary: string;
  container: string;
  output?: string;
  recipe?: string;
  nodes: readonly BuiltNode[];
  edges: readonly BuiltEdge[];
  warnings: readonly string[];
  errors: ReadonlyArray<{ path: string; message: string }>;
  preview?: { base64: string; mimeType: string };
}

export interface BuildRecord {
  schemaVersion: number;
  id: string;
  createdAt: string;
  /** Registered tool that produced the build; absent for direct CLI calls. */
  tool?: string;
  args?: Record<string, unknown>;
  summary: string;
  container: string;
  output?: string;
  recipe?: string;
  nodes: BuiltNode[];
  edges: BuiltEdge[];
  warnings: string[];
  errors: Array<{ path: string; message: string }>;
  /** Preview file, relative to the log directory. */
  preview?: string;
}

export interface BuildRecorder {
  /** Persists one build. Never rejects. */
  record(input: BuildRecordInput): Promise<void>;
}

export interface BuildRecorderOptions {
  dir?: string;
  maxRecords?: number;
  logger: Logger;
}

export function defaultBuildLogDir(): string {
  return join(homedir(), ".tdmcp", "builds");
}

interface ToolCallScope {
  tool: string;
  args: unknown;
}

const toolCallScope = new AsyncLocalStorage<ToolCallScope>();

/**
 * Runs a registered tool handler with its name and arguments in scope, so
 * `finalize` can attribute a build without every tool passing them through.
 */
export function withToolCall<T>(scope: ToolCallScope, fn: () => T): T {
  return toolCallScope.run(scope, fn);
}

/** Masks credentials embedded in free text (URLs and bearer tokens). */
function maskCredentials(value: string): string {
  return value
    .replace(/:\/\/([^/\s:@]+):([^/\s@]+)@/g, "://***:***@")
    .replace(/\b[Bb]earer\s+[A-Za-z0-9._~+/-]+=*/g, "Bearer ***");
}

function boundText(value: string, max: number): string {
  const masked = maskCredentials(value);
  return masked.length > max ? `${masked.slice(0, max)}…[truncated]` : masked;
}

function boundValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return boundText(value, MAX_STRING_CHARS);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => boundValue(item, depth + 1));
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, boundValue(item, depth + 1)]),
  );
}

/** Redacts secret-looking keys, then bounds the result for storage. */
function sanitizeFields(tool: string, fields: unknown): Record<string, unknown> {
  return boundValue(redactArgs(tool, fields)) as Record<string, unknown>;
}

function buildRecord(id: string, input: BuildRecordInput): BuildRecord {
  const scope = toolCallScope.getStore();
  const tool = scope?.tool ?? "";
  return {
    schemaVersion: BUILD_LOG_SCHEMA_VERSION,
    id,
    createdAt: new Date().toISOString(),
    ...(scope ? { tool: scope.tool } : {}),
    ...(scope?.args !== undefined ? { args: sanitizeFields(tool, scope.args) } : {}),
    summary: boundText(input.summary, MAX_MESSAGE_CHARS),
    container: input.container,
    ...(input.output !== undefined ? { output: input.output } : {}),
    ...(input.recipe !== undefined ? { recipe: input.recipe } : {}),
    nodes: input.nodes.slice(0, MAX_NODES).map((node) => ({
      name: node.name,
      path: node.path,
      type: node.type,
      ...(node.parameters ? { parameters: sanitizeFields(tool, node.parameters) } : {}),
    })),
    edges: input.edges.slice(0, MAX_EDGES).map(({ from, to }) => ({ from, to })),
    warnings: input.warnings
      .slice(0, MAX_MESSAGES)
      .map((warning) => boundText(warning, MAX_MESSAGE_CHARS)),
    errors: input.errors.slice(0, MAX_MESSAGES).map(({ path, message }) => ({
      path,
      message: boundText(message, MAX_MESSAGE_CHARS),
    })),
  };
}

function previewExtension(mimeType: string): string {
  return /jpe?g/i.test(mimeType) ? "jpg" : "png";
}

function previewOf(line: string): string | undefined {
  try {
    const parsed = JSON.parse(line) as { preview?: unknown };
    return typeof parsed.preview === "string" ? parsed.preview : undefined;
  } catch {
    return undefined;
  }
}

export function createBuildRecorder(options: BuildRecorderOptions): BuildRecorder {
  const dir = options.dir ?? defaultBuildLogDir();
  const maxRecords = options.maxRecords ?? DEFAULT_BUILD_LOG_MAX_RECORDS;
  const logFile = join(dir, LOG_FILE);
  // Serialize writes in this process so pruning never races a pending append.
  let queue: Promise<void> = Promise.resolve();

  async function writePreview(id: string, input: BuildRecordInput): Promise<string | undefined> {
    const { preview } = input;
    if (!preview || preview.base64.length > MAX_PREVIEW_BASE64_CHARS) return undefined;
    const relative = join(PREVIEW_DIR, `${id}.${previewExtension(preview.mimeType)}`);
    await mkdir(join(dir, PREVIEW_DIR), { recursive: true, mode: 0o700 });
    await writeFile(join(dir, relative), Buffer.from(preview.base64, "base64"), { mode: 0o600 });
    return relative;
  }

  async function prune(): Promise<void> {
    const lines = (await readFile(logFile, "utf8")).split("\n").filter((line) => line.length > 0);
    if (lines.length <= maxRecords) return;
    const dropped = lines.slice(0, lines.length - maxRecords);
    atomicWriteFileSync(logFile, `${lines.slice(-maxRecords).join("\n")}\n`, "utf8");
    for (const line of dropped) {
      const preview = previewOf(line);
      if (preview) await rm(join(dir, preview), { force: true });
    }
  }

  async function write(record: BuildRecord, input: BuildRecordInput): Promise<void> {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const preview = await writePreview(record.id, input);
    const line = JSON.stringify(preview === undefined ? record : { ...record, preview });
    await appendFile(logFile, `${line}\n`, { mode: 0o600 });
    // appendFile only applies the mode on creation; keep an existing log private too.
    await chmod(logFile, 0o600);
    await prune();
  }

  const skipped = (err: unknown): void => {
    options.logger.debug("build log skipped", { err: String(err) });
  };

  return {
    record(input) {
      let record: BuildRecord;
      try {
        // Built before queueing, while the tool-call scope is still current.
        record = buildRecord(randomUUID(), input);
      } catch (err) {
        skipped(err);
        return Promise.resolve();
      }
      queue = queue.then(() => write(record, input)).catch(skipped);
      return queue;
    },
  };
}
