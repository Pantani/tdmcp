import { parseArgs } from "node:util";
import { z } from "zod";
import { TouchDesignerClient } from "../td-client/touchDesignerClient.js";
import type { TdBridgeLogs } from "../td-client/validators.js";
import { loadConfig, tdBaseUrl } from "../utils/config.js";

/**
 * `tdmcp log-tail` — poll the TD bridge's GET /api/logs endpoint and stream
 * matching lines to stderr. Companion to the one-shot `get_bridge_logs` MCP tool.
 */

export const logTailFilteredSchema = z.object({
  level: z.enum(["error", "warn", "info", "all"]).default("all"),
  since: z.string().datetime().optional(),
  grep: z.string().optional(),
  follow: z.boolean().default(false),
  intervalMs: z.number().int().min(200).max(10_000).default(1000),
  maxLines: z.number().int().min(1).max(1000).default(200),
  scope: z.string().optional(),
  json: z.boolean().default(false),
});

export type LogTailFilteredArgs = z.infer<typeof logTailFilteredSchema>;

// ---- severity helpers ----

const LEVEL_ORDER: Record<string, number> = { error: 0, warn: 1, warning: 1, info: 2, all: 99 };

function levelOf(severity: string): number {
  return LEVEL_ORDER[severity.toLowerCase()] ?? 99;
}

function passesLevel(lineSeverity: string, levelArg: string): boolean {
  if (levelArg === "all") return true;
  return levelOf(lineSeverity) <= levelOf(levelArg);
}

// ---- dedupe ring ----

class DedupeRing {
  private readonly keys = new Set<string>();
  private readonly queue: string[] = [];
  constructor(private readonly cap: number) {}

  has(key: string): boolean {
    return this.keys.has(key);
  }

  add(key: string): void {
    if (this.keys.has(key)) return;
    if (this.queue.length >= this.cap) {
      const evict = this.queue.shift();
      if (evict !== undefined) this.keys.delete(evict);
    }
    this.keys.add(key);
    this.queue.push(key);
  }
}

// ---- format helpers ----

function formatLine(
  line: { severity: string; source: string; absframe?: number; frame?: number; message: string },
  asJson: boolean,
): string {
  if (asJson) {
    return JSON.stringify({
      severity: line.severity,
      source: line.source,
      frame: line.absframe ?? line.frame,
      message: line.message,
    });
  }
  const frameStr =
    line.absframe !== undefined
      ? `f${line.absframe}`
      : line.frame !== undefined
        ? `f${line.frame}`
        : "";
  return `[${line.severity}] ${line.source}${frameStr ? ` ${frameStr}` : ""} ${line.message}`;
}

// ---- internal poll function (exported for testing) ----

export interface PollState {
  seen: DedupeRing;
  availableWarnEmitted: boolean;
}

export interface PollOnceResult {
  linesEmitted: number;
  available: boolean;
  connectionError: boolean;
}

export async function pollOnce(
  client: { getLogs(severity: string, maxLines: number, scope?: string): Promise<TdBridgeLogs> },
  args: LogTailFilteredArgs,
  state: PollState,
  grep: RegExp | null,
  onLine: (text: string) => void,
  onWarn: (msg: string) => void,
): Promise<PollOnceResult> {
  let result: TdBridgeLogs;
  try {
    result = await client.getLogs(args.level, args.maxLines, args.scope);
  } catch {
    return { linesEmitted: 0, available: true, connectionError: true };
  }

  if (!result.available && !state.availableWarnEmitted) {
    state.availableWarnEmitted = true;
    onWarn("[log-tail] Error DAT unavailable — no log data yet from TD\n");
  }

  let emitted = 0;
  for (const line of result.lines) {
    const key = `${line.absframe ?? line.frame ?? ""}|${line.source}|${line.message}`;
    if (state.seen.has(key)) continue;
    if (grep !== null && !grep.test(line.message)) continue;
    if (!passesLevel(line.severity, args.level)) continue;
    state.seen.add(key);
    onLine(`${formatLine(line, args.json)}\n`);
    emitted++;
  }

  return { linesEmitted: emitted, available: result.available, connectionError: false };
}

// ---- arg parsing ----

function parseCliArgs(argv: string[]): LogTailFilteredArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      level: { type: "string" },
      since: { type: "string" },
      grep: { type: "string" },
      follow: { type: "boolean", short: "f" },
      "interval-ms": { type: "string" },
      "max-lines": { type: "string" },
      scope: { type: "string" },
      json: { type: "boolean" },
    },
    strict: false,
  });

  const raw: Record<string, unknown> = {};
  if (values.level !== undefined) raw.level = values.level;
  if (values.since !== undefined) raw.since = values.since;
  if (values.grep !== undefined) raw.grep = values.grep;
  if (values.follow !== undefined) raw.follow = values.follow;
  if (values["interval-ms"] !== undefined) raw.intervalMs = Number(values["interval-ms"]);
  if (values["max-lines"] !== undefined) raw.maxLines = Number(values["max-lines"]);
  if (values.scope !== undefined) raw.scope = values.scope;
  if (values.json !== undefined) raw.json = values.json;

  return logTailFilteredSchema.parse(raw);
}

// ---- main export ----

export async function runLogTailFiltered(argv: string[]): Promise<number> {
  let args: LogTailFilteredArgs;
  try {
    args = parseCliArgs(argv);
  } catch (err) {
    process.stderr.write(`[log-tail] invalid arguments: ${String(err)}\n`);
    return 2;
  }

  // Compile grep regex early so we can exit 2 before any I/O.
  let grep: RegExp | null = null;
  if (args.grep !== undefined) {
    try {
      grep = new RegExp(args.grep);
    } catch {
      process.stderr.write(`[log-tail] invalid regex: ${args.grep}\n`);
      return 2;
    }
  }

  const config = loadConfig();
  const baseUrl = tdBaseUrl(config);
  const client = new TouchDesignerClient({ baseUrl, timeoutMs: 5000 });

  const state: PollState = { seen: new DedupeRing(2000), availableWarnEmitted: false };

  if (args.follow) {
    const url = `${baseUrl}/api/logs`;
    const grepSuffix = args.grep ? ` · grep=/${args.grep}/` : "";
    process.stderr.write(
      `[log-tail] polling ${url} every ${args.intervalMs}ms · level=${args.level}${grepSuffix}\n`,
    );
  }

  let totalLines = 0;
  let totalPolls = 0;
  let totalErrors = 0;
  let consecutiveErrors = 0;

  const onLine = (text: string) => process.stderr.write(text);
  const onWarn = (msg: string) => process.stderr.write(msg);

  const doOnePoll = async (): Promise<boolean> => {
    const res = await pollOnce(client, args, state, grep, onLine, onWarn);
    totalPolls++;
    if (res.connectionError) {
      consecutiveErrors++;
      totalErrors++;
      process.stderr.write(`[log-tail] connection error (${consecutiveErrors} consecutive)\n`);
      if (consecutiveErrors >= 3) return false; // signal exit 1
    } else {
      consecutiveErrors = 0;
      totalLines += res.linesEmitted;
    }
    return true;
  };

  if (!args.follow) {
    const ok = await doOnePoll();
    if (!ok) return 1;
    return 0;
  }

  // Follow mode — poll until SIGINT.
  let running = true;
  let resolveMain: (code: number) => void;
  const mainPromise = new Promise<number>((res) => {
    resolveMain = res;
  });

  const onSigint = () => {
    running = false;
    process.stderr.write(
      `\n[log-tail] stopped (${totalLines} lines, ${totalPolls} polls, ${totalErrors} errors)\n`,
    );
    resolveMain(0);
  };
  process.once("SIGINT", onSigint);

  const loop = async () => {
    while (running) {
      const ok = await doOnePoll();
      if (!ok) {
        running = false;
        resolveMain(1);
        return;
      }
      if (running) {
        await new Promise<void>((res) => setTimeout(res, args.intervalMs));
      }
    }
  };

  void loop();
  return mainPromise;
}
