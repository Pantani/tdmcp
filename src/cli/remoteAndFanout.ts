/**
 * `tdmcp fanout` CLI subcommand.
 *
 * Broadcasts a single MCP `tools/call` to multiple tdmcp HTTP transports in parallel,
 * aggregating results with Promise.allSettled so one slow/offline target never blocks
 * the others.
 *
 * Uses a hand-rolled JSON-RPC POST to `/mcp` (the Streamable HTTP MCP endpoint) because
 * it is trivially testable with msw and avoids an extra SSE session-setup round-trip for
 * the one-shot invocation pattern.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TargetOk {
  target: string;
  ok: true;
  durationMs: number;
  result: unknown;
}

export interface TargetFail {
  target: string;
  ok: false;
  durationMs: number;
  error: { kind: "timeout" | "connect" | "auth" | "tool" | "unknown"; message: string };
}

export type TargetResult = TargetOk | TargetFail;

export interface FanoutReport {
  tool: string;
  args: Record<string, unknown>;
  startedAt: string;
  totalMs: number;
  targets: TargetResult[];
  summary: { total: number; ok: number; failed: number };
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/** Parse a single `host:port` or `[::1]:port` string using the URL parser. */
function parseTarget(raw: string): { host: string; port: number } {
  const urlStr = `http://${raw}`;
  let u: URL;
  try {
    u = new URL(urlStr);
  } catch {
    throw new Error(`Cannot parse target "${raw}" as host:port`);
  }
  const port = parseInt(u.port, 10);
  if (Number.isNaN(port) || port <= 0 || port > 65535) {
    throw new Error(`Target "${raw}" has invalid or missing port`);
  }
  return { host: u.hostname, port };
}

function parseTargetList(raw: string): Array<{ host: string; port: number }> {
  return raw.split(",").map((s) => parseTarget(s.trim()));
}

export const FanoutArgsSchema = z.object({
  targets: z
    .array(z.object({ host: z.string().min(1), port: z.number().int().positive().max(65535) }))
    .min(1),
  tool: z.string().min(1),
  args: z.record(z.string(), z.unknown()).default({}),
  timeoutMs: z.number().int().positive().default(15000),
  token: z.string().min(1).optional(),
  scheme: z.enum(["http", "https"]).default("http"),
  concurrency: z.number().int().min(0).default(0),
  format: z.enum(["json", "table"]).default("table"),
  failFast: z.boolean().default(false),
});

export type FanoutArgs = z.infer<typeof FanoutArgsSchema>;

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

function parseArgv(
  argv: string[],
  env: Record<string, string | undefined>,
): { ok: true; args: FanoutArgs } | { ok: false; message: string } {
  const raw: Record<string, unknown> = {};

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i] ?? "";
    const val = argv[i + 1];

    if (flag === "--targets" && val !== undefined) {
      try {
        raw.targets = parseTargetList(val);
      } catch (e) {
        return { ok: false, message: String(e) };
      }
      i++;
    } else if (flag === "--tool" && val !== undefined) {
      raw.tool = val;
      i++;
    } else if (flag === "--args" && val !== undefined) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(val);
      } catch {
        return { ok: false, message: `--args is not valid JSON: ${val}` };
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return { ok: false, message: "--args must be a JSON object" };
      }
      raw.args = parsed;
      i++;
    } else if (flag === "--timeout-ms" && val !== undefined) {
      raw.timeoutMs = parseInt(val, 10);
      i++;
    } else if (flag === "--token" && val !== undefined) {
      raw.token = val;
      i++;
    } else if (flag === "--scheme" && val !== undefined) {
      raw.scheme = val;
      i++;
    } else if (flag === "--concurrency" && val !== undefined) {
      raw.concurrency = parseInt(val, 10);
      i++;
    } else if (flag === "--format" && val !== undefined) {
      raw.format = val;
      i++;
    } else if (flag === "--fail-fast") {
      raw.failFast = true;
    }
  }

  // env fallback for token
  if (raw.token === undefined && env.TDMCP_FANOUT_TOKEN !== undefined) {
    raw.token = env.TDMCP_FANOUT_TOKEN;
  }

  const result = FanoutArgsSchema.safeParse(raw);
  if (!result.success) {
    const msg = result.error.issues.map((i) => i.message).join("; ");
    return { ok: false, message: `Invalid arguments: ${msg}` };
  }
  return { ok: true, args: result.data };
}

// ---------------------------------------------------------------------------
// Per-target call (hand-rolled JSON-RPC POST)
// ---------------------------------------------------------------------------

function classifyError(err: unknown): TargetFail["error"] {
  const msg = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : "";
  if (name === "AbortError" || msg.includes("aborted") || msg.includes("timed out")) {
    return { kind: "timeout", message: msg };
  }
  if (
    msg.includes("ECONNREFUSED") ||
    msg.includes("ENOTFOUND") ||
    msg.includes("EHOSTUNREACH") ||
    msg.includes("fetch failed") ||
    msg.includes("Failed to fetch") ||
    msg.includes("NetworkError")
  ) {
    return { kind: "connect", message: msg };
  }
  if (
    msg.includes("401") ||
    msg.includes("403") ||
    msg.includes("Unauthorized") ||
    msg.includes("Forbidden")
  ) {
    return { kind: "auth", message: msg };
  }
  return { kind: "unknown", message: msg };
}

interface CallOneOpts {
  scheme: string;
  host: string;
  port: number;
  tool: string;
  args: Record<string, unknown>;
  timeoutMs: number;
  token?: string;
}

interface JsonRpcResponse {
  id: number;
  result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  error?: { code: number; message: string };
}

async function callOneTarget(opts: CallOneOpts): Promise<TargetResult> {
  const hostPart = opts.host.includes(":") ? `[${opts.host}]` : opts.host;
  const label = `${opts.host}:${opts.port}`;
  const url = `${opts.scheme}://${hostPart}:${opts.port}/mcp`;
  const t0 = Date.now();

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs);

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (opts.token !== undefined) {
      headers.Authorization = `Bearer ${opts.token}`;
    }

    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: opts.tool, arguments: opts.args },
    });

    let res: Response;
    try {
      res = await fetch(url, { method: "POST", headers, body, signal: ac.signal });
    } catch (fetchErr) {
      const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
      const name = fetchErr instanceof Error ? fetchErr.name : "";
      if (name === "AbortError") {
        return {
          target: label,
          ok: false,
          durationMs: Date.now() - t0,
          error: {
            kind: "timeout",
            message: `Request to ${label} timed out after ${opts.timeoutMs}ms`,
          },
        };
      }
      return {
        target: label,
        ok: false,
        durationMs: Date.now() - t0,
        error: classifyError(new Error(msg)),
      };
    }

    if (res.status === 401 || res.status === 403) {
      return {
        target: label,
        ok: false,
        durationMs: Date.now() - t0,
        error: { kind: "auth", message: `HTTP ${res.status} from ${label}` },
      };
    }

    if (!res.ok) {
      return {
        target: label,
        ok: false,
        durationMs: Date.now() - t0,
        error: { kind: "unknown", message: `HTTP ${res.status} from ${label}` },
      };
    }

    const json = (await res.json()) as JsonRpcResponse;

    if (json.error !== undefined) {
      return {
        target: label,
        ok: false,
        durationMs: Date.now() - t0,
        error: { kind: "unknown", message: json.error.message },
      };
    }

    const toolResult = json.result;
    if (toolResult?.isError === true) {
      const txt = toolResult.content?.find((c) => c.type === "text")?.text ?? "tool error";
      return {
        target: label,
        ok: false,
        durationMs: Date.now() - t0,
        error: { kind: "tool", message: txt },
      };
    }

    return { target: label, ok: true, durationMs: Date.now() - t0, result: toolResult };
  } catch (err) {
    return {
      target: label,
      ok: false,
      durationMs: Date.now() - t0,
      error: classifyError(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Chunked allSettled
// ---------------------------------------------------------------------------

async function runChunked<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<T[]> {
  if (concurrency <= 0) {
    const settled = await Promise.allSettled(tasks.map((t) => t()));
    return settled.map((r) => {
      if (r.status === "fulfilled") return r.value;
      // tasks never reject (they return TargetResult), but TypeScript requires handling
      throw r.reason as unknown;
    });
  }

  const results: T[] = [];
  for (let i = 0; i < tasks.length; i += concurrency) {
    const chunk = tasks.slice(i, i + concurrency);
    const settled = await Promise.allSettled(chunk.map((t) => t()));
    for (const r of settled) {
      if (r.status === "fulfilled") results.push(r.value);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

function padEnd(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function formatTable(report: FanoutReport, stdout: NodeJS.WritableStream): void {
  stdout.write(`\ntdmcp fanout → tool=${report.tool}  targets=${report.summary.total}\n\n`);
  stdout.write(`  ${padEnd("TARGET", 26)}${padEnd("STATUS", 9)}${padEnd("ms", 7)}NOTES\n`);
  stdout.write(`  ${"─".repeat(70)}\n`);
  for (const t of report.targets) {
    const status = t.ok ? "ok" : "FAIL";
    const notes = t.ok
      ? String(JSON.stringify(t.result)).slice(0, 40)
      : t.error.message.slice(0, 40);
    stdout.write(
      `  ${padEnd(t.target, 26)}${padEnd(status, 9)}${padEnd(String(t.durationMs), 7)}${notes}\n`,
    );
  }
  const s = report.summary;
  stdout.write(
    `\nSummary: ${s.ok}/${s.total} ok, ${s.failed} failed   total ${(report.totalMs / 1000).toFixed(2)}s   exit ${s.failed > 0 ? 1 : 0}\n`,
  );
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export interface FanoutOpts {
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  env?: Record<string, string | undefined>;
  now?: () => number;
}

export async function runRemoteFanout(argv: string[], opts: FanoutOpts = {}): Promise<number> {
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  const env = opts.env ?? (process.env as Record<string, string | undefined>);

  const parsed = parseArgv(argv, env);
  if (!parsed.ok) {
    stderr.write(`[tdmcp fanout] ${parsed.message}\n`);
    return 1;
  }

  const { args: fanoutArgs } = parsed;
  const startedAt = new Date().toISOString();
  const globalT0 = opts.now !== undefined ? opts.now() : Date.now();

  const tasks = fanoutArgs.targets.map(
    (t) => () =>
      callOneTarget({
        scheme: fanoutArgs.scheme,
        host: t.host,
        port: t.port,
        tool: fanoutArgs.tool,
        args: fanoutArgs.args,
        timeoutMs: fanoutArgs.timeoutMs,
        token: fanoutArgs.token,
      }),
  );

  const targetResults = await runChunked(tasks, fanoutArgs.concurrency);

  const totalMs = (opts.now !== undefined ? opts.now() : Date.now()) - globalT0;
  const okCount = targetResults.filter((r) => r.ok).length;
  const failed = targetResults.length - okCount;

  const report: FanoutReport = {
    tool: fanoutArgs.tool,
    args: fanoutArgs.args,
    startedAt,
    totalMs,
    targets: targetResults,
    summary: { total: targetResults.length, ok: okCount, failed },
  };

  if (fanoutArgs.format === "json") {
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    formatTable(report, stdout);
  }

  return failed > 0 ? 1 : 0;
}
