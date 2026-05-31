import { z } from "zod";
import { buildToolContext } from "../server/context.js";
import { type TdEvent, TdEventStream } from "../td-client/eventStream.js";
import { friendlyTdError } from "../td-client/types.js";
import { getTdPerformanceImpl } from "../tools/layer3/getTdPerformance.js";
import { summarizeTdErrorsImpl } from "../tools/layer3/summarizeTdErrors.js";
import type { ToolContext } from "../tools/types.js";
import { loadConfig, type TdmcpConfig, tdBaseUrl } from "../utils/config.js";
import { silentLogger } from "../utils/logger.js";

/**
 * `tdmcp dashboard` — read-only live TUI showing TD performance, error clusters,
 * and a rolling tail of bridge events. Refreshes on an interval; keys quit/pause/
 * force-refresh. No new MCP tool, no new bridge endpoint, no new dependency:
 * uses built-in `readline` + ANSI escapes only.
 */

export const dashboardArgsSchema = z.object({
  root_path: z.string().default("/project1"),
  target_fps: z.number().positive().default(60),
  interval_ms: z.number().int().min(250).max(10_000).default(1000),
  group_by: z.enum(["message", "type", "parent"]).default("message"),
  top_n_nodes: z.number().int().min(1).max(20).default(8),
  top_n_errors: z.number().int().min(1).max(20).default(5),
  event_tail: z.number().int().min(0).max(50).default(10),
  include_high_frequency: z.boolean().default(false),
  no_color: z.boolean().default(false),
  once: z.boolean().default(false),
  recursive: z.boolean().default(true),
});

export type DashboardArgs = z.infer<typeof dashboardArgsSchema>;

export interface DashboardPerf {
  totalCookMs: number;
  frameBudgetMs: number;
  nodes: Array<{ path: string; cook_time_ms: number; cook_count?: number }>;
  status: "ok" | "offline";
  error?: string;
}

export interface DashboardErrors {
  total: number;
  groups: Array<{
    key: string;
    count: number;
    sample: { path: string; message: string };
  }>;
  suggestions: string[];
  status: "ok" | "offline";
  error?: string;
}

export interface DashboardEventRow {
  ts: string;
  event: string;
  detail: string;
}

export interface DashboardModel {
  ts: string;
  paused: boolean;
  args: DashboardArgs;
  perf: DashboardPerf;
  errors: DashboardErrors;
  events: DashboardEventRow[];
}

export interface RenderOpts {
  color: boolean;
  width: number;
}

// ─── ANSI helpers ────────────────────────────────────────────────────────────

const ESC = "\x1b[";
const RESET = `${ESC}0m`;

function colorize(s: string, code: string, on: boolean): string {
  return on ? `${ESC}${code}m${s}${RESET}` : s;
}

// ─── Pure renderer ───────────────────────────────────────────────────────────

function pad(s: string, n: number): string {
  if (s.length >= n) return s.slice(0, n);
  return s + " ".repeat(n - s.length);
}

function rpad(s: string, n: number): string {
  if (s.length >= n) return s.slice(-n);
  return " ".repeat(n - s.length) + s;
}

function fmtMs(v: number): string {
  return v.toFixed(2);
}

function budgetBar(total: number, budget: number, width: number, color: boolean): string {
  const ratio = budget > 0 ? Math.max(0, Math.min(2, total / budget)) : 0;
  const filled = Math.min(width, Math.round((ratio / 2) * width));
  const bar = "█".repeat(filled) + "░".repeat(Math.max(0, width - filled));
  if (!color) return bar;
  const code = total <= budget ? "32" : total < 2 * budget ? "33" : "31";
  return colorize(bar, code, true);
}

function statusColor(total: number, budget: number, color: boolean): (s: string) => string {
  if (!color) return (s) => s;
  const code = total <= budget ? "32" : total < 2 * budget ? "33" : "31";
  return (s) => colorize(s, code, true);
}

/**
 * Pure render: builds a string snapshot of the model. Side-effect free so we can
 * snapshot-test it from a fixed model.
 */
export function renderFrame(model: DashboardModel, opts: RenderOpts): string {
  const { args, perf, errors, events } = model;
  const color = opts.color;
  const lines: string[] = [];

  // Header
  const offline = perf.status === "offline";
  const offlineLabel = offline
    ? colorize("● bridge offline", "31", color)
    : colorize("● bridge ok", "32", color);
  const pauseLabel = model.paused ? colorize("PAUSED", "33", color) : "running";
  lines.push(
    `tdmcp dashboard · ${args.root_path} · ${args.target_fps}fps target (${fmtMs(
      perf.frameBudgetMs,
    )}ms budget) · ${model.ts}`,
  );
  lines.push(
    `STATUS  ${offlineLabel}   refresh ${args.interval_ms}ms   ${pauseLabel}   q quit  p pause  r refresh`,
  );
  if (offline && perf.error) {
    lines.push(
      colorize(`  TD offline — ${perf.error}. retrying in ${args.interval_ms}ms`, "31", color),
    );
  }
  lines.push("");

  // Performance pane
  const pct =
    perf.frameBudgetMs > 0 ? Math.round((perf.totalCookMs / perf.frameBudgetMs) * 100) : 0;
  const totalColored = statusColor(
    perf.totalCookMs,
    perf.frameBudgetMs,
    color,
  )(`${fmtMs(perf.totalCookMs)}ms / ${fmtMs(perf.frameBudgetMs)}ms`);
  lines.push(
    `PERFORMANCE  total cook ${totalColored}  [${budgetBar(
      perf.totalCookMs,
      perf.frameBudgetMs,
      20,
      color,
    )}] ${pct}%`,
  );
  if (!offline) {
    lines.push(`  ${rpad("ms", 7)}  ${rpad("cooks", 8)}  path`);
    const slow = perf.nodes.slice(0, args.top_n_nodes);
    if (slow.length === 0) {
      lines.push("  (no nodes measured)");
    } else {
      for (const n of slow) {
        const ms = rpad(fmtMs(n.cook_time_ms), 7);
        const cooks = rpad(n.cook_count === undefined ? "—" : String(n.cook_count), 8);
        lines.push(`  ${ms}  ${cooks}  ${n.path}`);
      }
    }
  }
  lines.push("");

  // Errors pane
  const errHeader = `ERRORS  (group_by=${args.group_by})  ${errors.total} error${
    errors.total === 1 ? "" : "s"
  }, ${errors.groups.length} group${errors.groups.length === 1 ? "" : "s"}`;
  lines.push(errors.total > 0 ? colorize(errHeader, "31", color) : errHeader);
  if (errors.status === "offline" && errors.error) {
    lines.push(colorize(`  errors unavailable — ${errors.error}`, "31", color));
  } else if (errors.total === 0) {
    lines.push("  (no errors)");
  } else {
    for (const g of errors.groups.slice(0, args.top_n_errors)) {
      lines.push(
        `  ${rpad(`${g.count}×`, 5)}  ${pad(JSON.stringify(g.key), 30)}  sample: ${g.sample.path}`,
      );
    }
    for (const s of errors.suggestions) {
      lines.push(colorize(`  suggestion: ${s}`, "33", color));
    }
  }
  lines.push("");

  // Events pane — suppressed when event_tail = 0
  if (args.event_tail > 0) {
    const tail = events.slice(-args.event_tail);
    lines.push(
      `EVENTS  (last ${args.event_tail}, high-freq ${args.include_high_frequency ? "on" : "off"})`,
    );
    if (tail.length === 0) {
      lines.push(colorize("  (no events yet)", "90", color));
    } else {
      for (const ev of tail) {
        lines.push(colorize(`  ${ev.ts}  ${pad(ev.event, 18)}  ${ev.detail}`, "90", color));
      }
    }
  }

  return lines.join("\n");
}

// ─── Argument parsing ────────────────────────────────────────────────────────

type RawArgs = Record<string, string | boolean>;

/** Parses `--key=value` / `--key value` / `--flag` / `--no-flag` argv into a record. */
export function parseArgv(argv: string[]): { raw: RawArgs; json: boolean } {
  const raw: RawArgs = {};
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok?.startsWith("--")) continue;
    const body = tok.slice(2);
    if (body === "json") {
      json = true;
      continue;
    }
    if (body.includes("=")) {
      const eq = body.indexOf("=");
      const k = body.slice(0, eq).replace(/-/g, "_");
      raw[k] = body.slice(eq + 1);
      continue;
    }
    // `--no-color` is an explicit schema field (no_color=true), not a negation.
    if (body === "no-color") {
      raw.no_color = true;
      continue;
    }
    if (body.startsWith("no-")) {
      raw[body.slice(3).replace(/-/g, "_")] = false;
      continue;
    }
    const key = body.replace(/-/g, "_");
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      raw[key] = next;
      i++;
    } else {
      raw[key] = true;
    }
  }
  return { raw, json };
}

function coerce(raw: RawArgs): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "boolean") {
      out[k] = v;
      continue;
    }
    // try number
    if (v !== "" && !Number.isNaN(Number(v)) && /^-?\d+(?:\.\d+)?$/.test(v)) {
      out[k] = Number(v);
      continue;
    }
    if (v === "true") out[k] = true;
    else if (v === "false") out[k] = false;
    else out[k] = v;
  }
  return out;
}

// ─── Polling ─────────────────────────────────────────────────────────────────

async function pollPerf(ctx: ToolContext, args: DashboardArgs): Promise<DashboardPerf> {
  const budget = 1000 / args.target_fps;
  try {
    const result = await getTdPerformanceImpl(ctx, {
      root_path: args.root_path,
      target_fps: args.target_fps,
      recursive: args.recursive,
    });
    if (result.isError) {
      const text =
        result.content?.find((c) => c.type === "text")?.text ?? "performance call failed";
      return { totalCookMs: 0, frameBudgetMs: budget, nodes: [], status: "offline", error: text };
    }
    const sc = result.structuredContent as
      | {
          totalCookMs: number;
          frameBudgetMs: number;
          nodes: Array<{ path: string; cook_time_ms: number; cook_count?: number }>;
        }
      | undefined;
    if (!sc) {
      return {
        totalCookMs: 0,
        frameBudgetMs: budget,
        nodes: [],
        status: "offline",
        error: "no data",
      };
    }
    const sorted = [...sc.nodes].sort((a, b) => b.cook_time_ms - a.cook_time_ms);
    return {
      totalCookMs: sc.totalCookMs,
      frameBudgetMs: sc.frameBudgetMs,
      nodes: sorted,
      status: "ok",
    };
  } catch (err) {
    return {
      totalCookMs: 0,
      frameBudgetMs: budget,
      nodes: [],
      status: "offline",
      error: friendlyTdError(err),
    };
  }
}

async function pollErrors(ctx: ToolContext, args: DashboardArgs): Promise<DashboardErrors> {
  try {
    const result = await summarizeTdErrorsImpl(ctx, {
      path: args.root_path,
      group_by: args.group_by,
    });
    if (result.isError) {
      const text = result.content?.find((c) => c.type === "text")?.text ?? "errors call failed";
      return { total: 0, groups: [], suggestions: [], status: "offline", error: text };
    }
    const sc = result.structuredContent as
      | {
          total: number;
          groups: Array<{
            key: string;
            count: number;
            sample: { path: string; message: string };
          }>;
          suggestions: string[];
        }
      | undefined;
    if (!sc) {
      return { total: 0, groups: [], suggestions: [], status: "offline", error: "no data" };
    }
    return {
      total: sc.total,
      groups: sc.groups,
      suggestions: sc.suggestions,
      status: "ok",
    };
  } catch (err) {
    return {
      total: 0,
      groups: [],
      suggestions: [],
      status: "offline",
      error: friendlyTdError(err),
    };
  }
}

function eventDetail(data: unknown): string {
  if (data == null) return "";
  if (typeof data === "string") return data.slice(0, 80);
  if (typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (typeof obj.path === "string") {
      const msg = typeof obj.message === "string" ? `  ${obj.message}` : "";
      return `${obj.path}${msg}`.slice(0, 80);
    }
    try {
      return JSON.stringify(data).slice(0, 80);
    } catch {
      return "";
    }
  }
  return String(data).slice(0, 80);
}

function nowTs(date: Date = new Date()): string {
  return date.toTimeString().slice(0, 8);
}

// ─── Snapshot collection ─────────────────────────────────────────────────────

export interface CollectOptions {
  ctx: ToolContext;
  args: DashboardArgs;
  events: DashboardEventRow[];
  paused?: boolean;
}

export async function collectSnapshot(opts: CollectOptions): Promise<DashboardModel> {
  const [perf, errors] = await Promise.all([
    pollPerf(opts.ctx, opts.args),
    pollErrors(opts.ctx, opts.args),
  ]);
  return {
    ts: nowTs(),
    paused: opts.paused ?? false,
    args: opts.args,
    perf,
    errors,
    events: opts.events.slice(),
  };
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export interface RunDashboardOptions {
  config?: TdmcpConfig;
  makeCtx?: (config: TdmcpConfig) => ToolContext;
  /** Test seam: inject initial events instead of opening a real WebSocket. */
  seedEvents?: DashboardEventRow[];
  /** Test seam: write target (defaults to process.stdout). */
  out?: { write: (s: string) => void; isTTY?: boolean };
}

function shouldUseColor(args: DashboardArgs, out: { isTTY?: boolean }): boolean {
  if (args.no_color) return false;
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") return false;
  return out.isTTY === true;
}

/**
 * Single-frame snapshot for `--json`. Mirrors the in-TUI model shape but keeps
 * only the data fields (no `ts` formatting, no `args` echo) so it's scriptable.
 */
function jsonSnapshot(model: DashboardModel): unknown {
  return {
    ts: model.ts,
    perf: {
      totalCookMs: model.perf.totalCookMs,
      frameBudgetMs: model.perf.frameBudgetMs,
      status: model.perf.status,
      nodes: model.perf.nodes,
      ...(model.perf.error ? { error: model.perf.error } : {}),
    },
    errors: {
      total: model.errors.total,
      groups: model.errors.groups,
      suggestions: model.errors.suggestions,
      status: model.errors.status,
      ...(model.errors.error ? { error: model.errors.error } : {}),
    },
    events: model.events,
  };
}

/**
 * `tdmcp dashboard` entry. Returns the exit code; never throws on a bridge
 * failure (rendered as an offline banner).
 */
export async function runDashboard(
  argv: string[],
  options: RunDashboardOptions = {},
): Promise<number> {
  const { raw, json } = parseArgv(argv);
  const parsed = dashboardArgsSchema.safeParse(coerce(raw));
  if (!parsed.success) {
    const out = options.out ?? process.stderr;
    out.write(`tdmcp dashboard: invalid arguments — ${parsed.error.message}\n`);
    return 2;
  }
  const args: DashboardArgs = parsed.data;

  let config: TdmcpConfig;
  try {
    config = options.config ?? loadConfig();
  } catch (err) {
    const out = options.out ?? process.stderr;
    out.write(`tdmcp dashboard: invalid configuration — ${(err as Error).message}\n`);
    return 1;
  }

  const ctx = options.makeCtx
    ? options.makeCtx(config)
    : buildToolContext(config, { logger: silentLogger });

  const events: DashboardEventRow[] = options.seedEvents ? [...options.seedEvents] : [];
  const out = options.out ?? process.stdout;
  const color = shouldUseColor(args, out);

  // --json or --once: do a single snapshot and exit. Both are scriptable, no TUI.
  if (json || args.once) {
    const model = await collectSnapshot({ ctx, args, events });
    if (json) {
      out.write(`${JSON.stringify(jsonSnapshot(model))}\n`);
      return 0;
    }
    out.write(`${renderFrame(model, { color, width: 100 })}\n`);
    return 0;
  }

  // Live mode: only when stdout is a TTY. Otherwise degrade to a single frame.
  if (out.isTTY !== true) {
    const model = await collectSnapshot({ ctx, args, events });
    out.write(`${renderFrame(model, { color: false, width: 100 })}\n`);
    return 0;
  }

  // Open the event stream (best effort — failures are absorbed by the stream).
  const stream = new TdEventStream({
    url: `${tdBaseUrl(config).replace(/^http/, "ws")}/events`,
    includeHighFrequency: args.include_high_frequency,
    onEvent: (ev: TdEvent) => {
      events.push({ ts: nowTs(), event: ev.event, detail: eventDetail(ev.data) });
      if (events.length > 200) events.splice(0, events.length - 200);
    },
    logger: silentLogger,
  });
  try {
    stream.start();
  } catch {
    // ignore — events are optional
  }

  let paused = false;
  let interval = args.interval_ms;
  let exitCode = 0;

  const draw = async (): Promise<void> => {
    const model = await collectSnapshot({
      ctx,
      args: { ...args, interval_ms: interval },
      events,
      paused,
    });
    out.write("\x1b[2J\x1b[H");
    out.write(`${renderFrame(model, { color, width: 100 })}\n`);
  };

  // Keypress wiring (best-effort; bail to one-frame if stdin isn't usable).
  let stdinRaw = false;
  const stdin = process.stdin;
  const readline = await import("node:readline");
  try {
    readline.emitKeypressEvents(stdin);
    if (stdin.isTTY && typeof stdin.setRawMode === "function") {
      stdin.setRawMode(true);
      stdinRaw = true;
    }
  } catch {
    // ignore — we still render on the interval
  }

  return await new Promise<number>((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    const cleanup = (): void => {
      if (timer) clearInterval(timer);
      try {
        if (stdinRaw && typeof stdin.setRawMode === "function") stdin.setRawMode(false);
        stdin.pause();
      } catch {
        // ignore
      }
      try {
        stream.close();
      } catch {
        // ignore
      }
      resolve(exitCode);
    };

    const tick = async (): Promise<void> => {
      if (paused) return;
      await draw();
    };

    const onKey = (_str: string, key: { name?: string; ctrl?: boolean }): void => {
      if (!key) return;
      if (key.name === "q" || (key.ctrl && key.name === "c")) {
        cleanup();
        return;
      }
      if (key.name === "p") {
        paused = !paused;
        void draw();
        return;
      }
      if (key.name === "r") {
        void draw();
        return;
      }
      if (_str === "+" || _str === "=") {
        interval = Math.min(10_000, interval + 250);
        void draw();
        return;
      }
      if (_str === "-") {
        interval = Math.max(250, interval - 250);
        void draw();
        return;
      }
    };

    stdin.on("keypress", onKey);

    void draw().catch(() => {
      exitCode = 0; // still exit clean — friendly error already rendered
    });

    timer = setInterval(() => {
      void tick();
    }, interval);
    timer.unref?.();
  });
}
