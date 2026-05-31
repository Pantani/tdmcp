/**
 * `tdmcp record-fixtures` — wraps the TD bridge fetch in a tee that captures
 * every request/response pair to a JSON fixture file replayable by msw.
 *
 * Architecture: a pure functional core (wrapRecordingFetch, FixtureWriter)
 * plus a top-level runner (runFixtureRecorder) that boots the MCP server.
 * The runner is wired into src/index.ts by td-integrator; the core is the
 * unit-testable surface used in tests/unit/fixtureRecorder.test.ts.
 */

import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface FixtureEntry {
  id: number;
  method: string;
  url: string;
  request: {
    headers: Record<string, string>;
    body: unknown;
  };
  response: {
    status: number;
    headers: Record<string, string>;
    body: unknown;
  };
  durationMs: number;
}

export interface FixtureFile {
  version: 1;
  recordedAt: string;
  baseUrl: string;
  entries: FixtureEntry[];
}

// ---------------------------------------------------------------------------
// Schema & args
// ---------------------------------------------------------------------------

export const fixtureRecorderSchema = z.object({
  out: z.string().optional(),
  include: z.array(z.string()).default(["*"]),
  exclude: z.array(z.string()).default([]),
  max: z.number().int().min(1).default(500),
  duration: z.number().min(0).default(0),
  redactBody: z.boolean().default(true),
  pretty: z.boolean().default(true),
  mode: z.enum(["server", "passthrough"]).default("server"),
});

export type FixtureRecorderArgs = z.infer<typeof fixtureRecorderSchema>;

// ---------------------------------------------------------------------------
// Glob-style path matching (simple: * = any segment, no sub-path chars)
// ---------------------------------------------------------------------------

function matchPattern(pathname: string, pattern: string): boolean {
  if (pattern === "*") return true;
  // Convert glob (* = any sequence except /) to regex
  const re = new RegExp(
    "^" +
      pattern
        .split("*")
        .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^?#]*") +
      "$",
  );
  return re.test(pathname);
}

function matchesAny(pathname: string, patterns: string[]): boolean {
  return patterns.some((p) => matchPattern(pathname, p));
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

const REDACT_HEADER_KEYS = new Set(["authorization", "x-bridge-token"]);
const REDACT_BODY_KEYS = new Set(["token", "secret"]);

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = REDACT_HEADER_KEYS.has(k.toLowerCase()) ? v.replace(/^(Bearer\s+).+$/i, "$1***") : v;
  }
  return out;
}

function redactBodyValue(obj: unknown, depth = 0): unknown {
  if (depth > 10 || obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map((v) => redactBodyValue(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    out[k] = REDACT_BODY_KEYS.has(k.toLowerCase()) ? "***" : redactBodyValue(v, depth + 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Body size cap (256 KB)
// ---------------------------------------------------------------------------

const BODY_CAP_BYTES = 256 * 1024;

function maybeTruncate(text: string): unknown {
  const size = Buffer.byteLength(text, "utf8");
  if (size > BODY_CAP_BYTES) return { truncated: true, size };
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ---------------------------------------------------------------------------
// FixtureWriter — accumulates entries in memory, writes on finalize()
// ---------------------------------------------------------------------------

export class FixtureWriter {
  readonly entries: FixtureEntry[] = [];
  private readonly baseUrl: string;
  private readonly startedAt: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
    this.startedAt = new Date().toISOString();
  }

  append(entry: FixtureEntry): void {
    this.entries.push(entry);
  }

  async finalize(outPath: string, pretty: boolean): Promise<void> {
    const fixture: FixtureFile = {
      version: 1,
      recordedAt: this.startedAt,
      baseUrl: this.baseUrl,
      entries: this.entries,
    };
    await mkdir(dirname(outPath), { recursive: true });
    const json = pretty ? JSON.stringify(fixture, null, 2) : JSON.stringify(fixture);
    await writeFile(outPath, json, "utf8");
  }
}

// ---------------------------------------------------------------------------
// wrapRecordingFetch — the tee
// ---------------------------------------------------------------------------

export interface RecordingFilters {
  include: string[];
  exclude: string[];
  max: number;
  redactBody: boolean;
}

export function wrapRecordingFetch(
  realFetch: typeof fetch,
  writer: FixtureWriter,
  filters: RecordingFilters,
): typeof fetch {
  return async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const urlStr =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(urlStr);
    const pathname = url.pathname;
    const method = (init?.method ?? "GET").toUpperCase();

    const shouldRecord =
      writer.entries.length < filters.max &&
      matchesAny(pathname, filters.include) &&
      !matchesAny(pathname, filters.exclude);

    if (!shouldRecord) {
      return realFetch(input, init);
    }

    // Capture request body
    let rawReqBody = "";
    if (init?.body) {
      rawReqBody =
        typeof init.body === "string"
          ? init.body
          : init.body instanceof Uint8Array
            ? Buffer.from(init.body).toString("utf8")
            : String(init.body);
    }

    // Capture request headers
    const reqHeaders: Record<string, string> = {};
    if (init?.headers) {
      // biome-ignore lint/suspicious/noExplicitAny: Headers accepts varied init shapes; types differ across DOM/undici.
      const h = new Headers(init.headers as any);
      h.forEach((v, k) => {
        reqHeaders[k] = v;
      });
    }

    const t0 = Date.now();
    const response = await realFetch(input, init);
    const durationMs = Date.now() - t0;

    // Clone to read body without consuming the original
    const cloned = response.clone();
    const rawRespBody = await cloned.text();

    // Collect response headers
    const respHeaders: Record<string, string> = {};
    response.headers.forEach((v, k) => {
      respHeaders[k] = v;
    });

    let reqBodyParsed: unknown = maybeTruncate(rawReqBody);
    let respBodyParsed: unknown = maybeTruncate(rawRespBody);

    if (filters.redactBody) {
      reqBodyParsed = redactBodyValue(reqBodyParsed);
      respBodyParsed = redactBodyValue(respBodyParsed);
    }

    const finalReqHeaders = filters.redactBody ? redactHeaders(reqHeaders) : reqHeaders;

    const entry: FixtureEntry = {
      id: writer.entries.length + 1,
      method,
      url: pathname + (url.search || ""),
      request: { headers: finalReqHeaders, body: reqBodyParsed },
      response: { status: response.status, headers: respHeaders, body: respBodyParsed },
      durationMs,
    };

    writer.append(entry);
    return response;
  };
}

// ---------------------------------------------------------------------------
// mountFixture — helper to replay a fixture file via msw handlers
// (exported so tests can use it; the integrator doesn't need to wire this)
// ---------------------------------------------------------------------------

export function mountFixture(
  // typed loosely so callers don't need to import msw types
  mswServer: {
    // biome-ignore lint/suspicious/noExplicitAny: loosely typed so callers don't need msw types
    use: (...handlers: any[]) => void;
  },
  fixture: FixtureFile,
  httpHandlers: {
    get: (url: string, handler: () => unknown) => unknown;
    post: (url: string, handler: () => unknown) => unknown;
    patch: (url: string, handler: () => unknown) => unknown;
    delete: (url: string, handler: () => unknown) => unknown;
  },
  HttpResponseJson: (body: unknown, init?: { status?: number }) => unknown,
): void {
  for (const entry of fixture.entries) {
    const fullUrl = fixture.baseUrl + entry.url;
    const m = entry.method.toLowerCase() as "get" | "post" | "patch" | "delete";
    const handler = httpHandlers[m];
    if (handler) {
      (mswServer.use as (...h: unknown[]) => void)(
        handler(fullUrl, () =>
          HttpResponseJson(entry.response.body, { status: entry.response.status }),
        ),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// runFixtureRecorder — top-level entry point (wired by integrator)
// ---------------------------------------------------------------------------

export async function runFixtureRecorder(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      out: { type: "string" },
      include: { type: "string", multiple: true },
      exclude: { type: "string", multiple: true },
      max: { type: "string" },
      duration: { type: "string" },
      "redact-body": { type: "string" },
      pretty: { type: "string" },
      mode: { type: "string" },
    },
    strict: false,
  });

  const parsed = fixtureRecorderSchema.parse({
    out: values.out,
    include: values.include ?? [],
    exclude: values.exclude ?? [],
    max: values.max !== undefined ? Number(values.max) : undefined,
    duration: values.duration !== undefined ? Number(values.duration) : undefined,
    redactBody:
      (values as Record<string, unknown>)["redact-body"] !== undefined
        ? (values as Record<string, unknown>)["redact-body"] !== "false"
        : undefined,
    pretty: values.pretty !== undefined ? values.pretty !== "false" : undefined,
    mode: values.mode,
  });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = resolve(parsed.out ?? `tests/fixtures/recorded/${timestamp}.json`);

  // Check file doesn't already exist (safety — avoid overwriting)
  try {
    const parentDir = dirname(outPath);
    await mkdir(parentDir, { recursive: true });
    const files = await readdir(dirname(outPath));
    const basename = outPath.split("/").pop() ?? "";
    if (files.includes(basename)) {
      console.error(
        `[fixture-recorder] error: ${outPath} already exists. Use a different --out path.`,
      );
      process.exit(1);
    }
  } catch {
    // directory didn't exist — that's fine, mkdir created it
  }

  if (parsed.mode === "passthrough") {
    console.log("[fixture-recorder] passthrough mode is reserved for v2 — exiting.");
    process.exit(0);
  }

  // Lazy-import to keep this file loadable without the full server stack
  const { loadConfig } = await import("../utils/config.js");
  const { createTdmcpServer } = await import("../server/tdmcpServer.js");
  const { startTransport } = await import("../server/transportFactory.js");

  const cfg = loadConfig();
  const baseUrl = `http://${cfg.tdHost}:${cfg.tdPort}`;

  const writer = new FixtureWriter(baseUrl);

  const filters: RecordingFilters = {
    include: parsed.include.length > 0 ? parsed.include : ["*"],
    exclude: parsed.exclude,
    max: parsed.max,
    redactBody: parsed.redactBody,
  };

  const recordingFetch = wrapRecordingFetch(fetch, writer, filters);

  console.log(`[fixture-recorder] writing to ${outPath}`);
  if (filters.include[0] !== "*") {
    console.log(`[fixture-recorder] include: ${filters.include.join(", ")}`);
  }
  if (filters.exclude.length > 0) {
    console.log(`[fixture-recorder] exclude: ${filters.exclude.join(", ")}`);
  }
  console.log(`[fixture-recorder] bridge: ${baseUrl}`);

  const { createLogger } = await import("../utils/logger.js");
  const logger = createLogger(cfg.logLevel);

  // Wall-clock duration cap
  let durationTimer: ReturnType<typeof setTimeout> | undefined;
  if (parsed.duration > 0) {
    durationTimer = setTimeout(async () => {
      await flush();
      process.exit(0);
    }, parsed.duration * 1000);
  }

  const flush = async (): Promise<void> => {
    if (durationTimer) clearTimeout(durationTimer);
    console.log(`\n[fixture-recorder] flushing ${writer.entries.length} entries → ${outPath}`);
    await writer.finalize(outPath, parsed.pretty);
    console.log("[fixture-recorder] done.");
  };

  process.on("SIGINT", async () => {
    await flush();
    process.exit(0);
  });

  console.log("[fixture-recorder] mcp server up on stdio — drive it from your MCP client now");
  await startTransport(() => createTdmcpServer(cfg, { fetchImpl: recordingFetch }), cfg, logger);
  await flush();
}
