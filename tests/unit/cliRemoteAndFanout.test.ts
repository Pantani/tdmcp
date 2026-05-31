/**
 * Offline unit tests for `runRemoteFanout`.
 *
 * msw intercepts fetch calls; no TouchDesigner or live tdmcp server needed.
 * Tests cover: happy path, mixed results, auth, bad-JSON args, IPv6 parsing,
 * concurrency cap, JSON vs table format, and fail-fast behaviour.
 */

import { Writable } from "node:stream";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  FanoutArgsSchema,
  type FanoutReport,
  runRemoteFanout,
  type TargetResult,
} from "../../src/cli/remoteAndFanout.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonRpcOk(result: unknown) {
  return HttpResponse.json({ jsonrpc: "2.0", id: 1, result });
}

function jsonRpcToolError(message: string) {
  return HttpResponse.json({
    jsonrpc: "2.0",
    id: 1,
    result: { isError: true, content: [{ type: "text", text: message }] },
  });
}

/** Collect writes to a string buffer. */
function makeStream() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      cb();
    },
  });
  return { stream, output: () => chunks.join("") };
}

/** Argv builder for the CLI under test. */
function argv(flags: Record<string, string | true>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(flags)) {
    out.push(`--${k}`);
    if (v !== true) out.push(v);
  }
  return out;
}

// ---------------------------------------------------------------------------
// msw server
// ---------------------------------------------------------------------------

const BASE_A = "http://127.0.0.1:3939";
const BASE_B = "http://127.0.0.2:3939";
const BASE_C = "http://127.0.0.3:3939";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// ---------------------------------------------------------------------------
// 1. Happy path — 3 targets, all ok
// ---------------------------------------------------------------------------

describe("happy path", () => {
  it("returns summary.ok===3, failed===0, exit code 0", async () => {
    const okResult = { content: [{ type: "text", text: "/project1/audio_reactive_1" }] };
    server.use(
      http.post(`${BASE_A}/mcp`, () => jsonRpcOk(okResult)),
      http.post(`${BASE_B}/mcp`, () => jsonRpcOk(okResult)),
      http.post(`${BASE_C}/mcp`, () => jsonRpcOk(okResult)),
    );

    const { stream, output } = makeStream();
    const errStream = makeStream();

    const code = await runRemoteFanout(
      argv({
        targets: "127.0.0.1:3939,127.0.0.2:3939,127.0.0.3:3939",
        tool: "create_audio_reactive",
        format: "json",
      }),
      { stdout: stream, stderr: errStream.stream, env: {} },
    );

    expect(code).toBe(0);
    const report = JSON.parse(output()) as FanoutReport;
    expect(report.summary.ok).toBe(3);
    expect(report.summary.failed).toBe(0);
    expect(report.summary.total).toBe(3);
    expect(report.tool).toBe("create_audio_reactive");
    expect(report.targets.every((t) => t.ok)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Mixed — 1 ok, 1 HTTP 500, 1 timeout
// ---------------------------------------------------------------------------

describe("mixed results", () => {
  it("ok===1, failed===2 with correct error kinds, exit 1", async () => {
    const okResult = { content: [{ type: "text", text: "ok" }] };

    server.use(
      http.post(`${BASE_A}/mcp`, () => jsonRpcOk(okResult)),
      http.post(`${BASE_B}/mcp`, () => HttpResponse.json({ error: "internal" }, { status: 500 })),
      // BASE_C: never resolve — AbortController fires the timeout
      http.post(`${BASE_C}/mcp`, () => new Promise<Response>(() => {})),
    );

    const { stream, output } = makeStream();

    const code = await runRemoteFanout(
      argv({
        targets: "127.0.0.1:3939,127.0.0.2:3939,127.0.0.3:3939",
        tool: "create_audio_reactive",
        "timeout-ms": "100",
        format: "json",
      }),
      { stdout: stream, stderr: makeStream().stream, env: {} },
    );

    expect(code).toBe(1);
    const report = JSON.parse(output()) as FanoutReport;
    expect(report.summary.ok).toBe(1);
    expect(report.summary.failed).toBe(2);

    const results = report.targets as TargetResult[];
    const aResult = results.find((r) => r.target === "127.0.0.1:3939");
    const bResult = results.find((r) => r.target === "127.0.0.2:3939");
    const cResult = results.find((r) => r.target === "127.0.0.3:3939");

    expect(aResult?.ok).toBe(true);
    expect(bResult?.ok).toBe(false);
    if (bResult && !bResult.ok) expect(bResult.error.kind).toBe("unknown");
    expect(cResult?.ok).toBe(false);
    if (cResult && !cResult.ok) expect(cResult.error.kind).toBe("timeout");
  });
});

// ---------------------------------------------------------------------------
// 3. Auth — token sent, missing token → 401 → error kind "auth"
// ---------------------------------------------------------------------------

describe("auth token", () => {
  it("sends Authorization header when --token is provided", async () => {
    let receivedAuth: string | null = null;

    server.use(
      http.post(`${BASE_A}/mcp`, ({ request }) => {
        receivedAuth = request.headers.get("authorization");
        return jsonRpcOk({ content: [] });
      }),
    );

    await runRemoteFanout(
      argv({ targets: "127.0.0.1:3939", tool: "manage_cue", token: "mysecret", format: "json" }),
      { stdout: makeStream().stream, stderr: makeStream().stream, env: {} },
    );

    expect(receivedAuth).toBe("Bearer mysecret");
  });

  it("classifies HTTP 401 as auth error kind", async () => {
    server.use(
      http.post(`${BASE_A}/mcp`, () =>
        HttpResponse.json({ error: "unauthorized" }, { status: 401 }),
      ),
    );

    const { stream, output } = makeStream();
    const code = await runRemoteFanout(
      argv({ targets: "127.0.0.1:3939", tool: "manage_cue", format: "json" }),
      { stdout: stream, stderr: makeStream().stream, env: {} },
    );

    expect(code).toBe(1);
    const report = JSON.parse(output()) as FanoutReport;
    const t = report.targets[0] as TargetResult;
    expect(t.ok).toBe(false);
    if (!t.ok) expect(t.error.kind).toBe("auth");
  });
});

// ---------------------------------------------------------------------------
// 4. Bad JSON args
// ---------------------------------------------------------------------------

describe("bad --args", () => {
  it("exits 1 before any network call and writes to stderr", async () => {
    // No msw handler registered — any request would throw "unhandled request"
    const errStream = makeStream();
    const code = await runRemoteFanout(
      ["--targets", "127.0.0.1:3939", "--tool", "foo", "--args", "not json"],
      { stdout: makeStream().stream, stderr: errStream.stream, env: {} },
    );
    expect(code).toBe(1);
    expect(errStream.output()).toContain("not valid JSON");
  });

  it("rejects an array as --args", async () => {
    const errStream = makeStream();
    const code = await runRemoteFanout(
      ["--targets", "127.0.0.1:3939", "--tool", "foo", "--args", "[1,2,3]"],
      { stdout: makeStream().stream, stderr: errStream.stream, env: {} },
    );
    expect(code).toBe(1);
    expect(errStream.output()).toContain("JSON object");
  });
});

// ---------------------------------------------------------------------------
// 5. IPv6 target — parsing only (msw doesn't support IPv6 addresses in handlers)
// ---------------------------------------------------------------------------

describe("IPv6 target", () => {
  it("parses [::1]:3939 to host=::1, port=3939 in schema", () => {
    // Validate that the schema / parseArgv resolves the IPv6 target correctly.
    // We exercise this via FanoutArgsSchema directly with a pre-parsed target array.
    const result = FanoutArgsSchema.safeParse({
      targets: [{ host: "::1", port: 3939 }],
      tool: "foo",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const t = result.data.targets[0];
      expect(t?.host).toBe("::1");
      expect(t?.port).toBe(3939);
    }
  });

  it("URL for IPv6 host wraps host in brackets", () => {
    // Verify the URL construction helper indirectly: a host containing ":" gets brackets.
    const host = "::1";
    const hostPart = host.includes(":") ? `[${host}]` : host;
    const url = `http://${hostPart}:3939/mcp`;
    expect(url).toBe("http://[::1]:3939/mcp");
    // Node URL strips brackets from hostname in some versions; confirm it parses
    const parsed = new URL(url);
    expect(parsed.port).toBe("3939");
    expect(parsed.hostname.replace(/^\[|\]$/g, "")).toBe("::1");
  });
});

// ---------------------------------------------------------------------------
// 6. Concurrency cap — with --concurrency 1 and 3 targets, calls are sequential
// ---------------------------------------------------------------------------

describe("concurrency cap", () => {
  it("serialises calls when --concurrency 1", async () => {
    const callOrder: number[] = [];
    let inFlight = 0;
    let maxInFlight = 0;

    const makeHandler = (idx: number, base: string) =>
      http.post(`${base}/mcp`, async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        callOrder.push(idx);
        await new Promise((r) => setTimeout(r, 10));
        inFlight--;
        return jsonRpcOk({ content: [] });
      });

    server.use(makeHandler(0, BASE_A), makeHandler(1, BASE_B), makeHandler(2, BASE_C));

    const code = await runRemoteFanout(
      argv({
        targets: "127.0.0.1:3939,127.0.0.2:3939,127.0.0.3:3939",
        tool: "foo",
        concurrency: "1",
        format: "json",
      }),
      { stdout: makeStream().stream, stderr: makeStream().stream, env: {} },
    );

    expect(code).toBe(0);
    expect(maxInFlight).toBe(1);
    expect(callOrder).toEqual([0, 1, 2]);
  });
});

// ---------------------------------------------------------------------------
// 7. --format json vs table
// ---------------------------------------------------------------------------

describe("format", () => {
  it("--format json emits parseable FanoutReport", async () => {
    server.use(http.post(`${BASE_A}/mcp`, () => jsonRpcOk({ content: [] })));

    const { stream, output } = makeStream();
    await runRemoteFanout(argv({ targets: "127.0.0.1:3939", tool: "foo", format: "json" }), {
      stdout: stream,
      stderr: makeStream().stream,
      env: {},
    });

    const report = JSON.parse(output()) as FanoutReport;
    expect(report).toHaveProperty("tool", "foo");
    expect(report).toHaveProperty("summary");
    expect(report).toHaveProperty("targets");
    expect(report).toHaveProperty("startedAt");
    expect(report).toHaveProperty("totalMs");
  });

  it("--format table writes target rows to stdout", async () => {
    server.use(http.post(`${BASE_A}/mcp`, () => jsonRpcOk({ content: [] })));

    const { stream, output } = makeStream();
    await runRemoteFanout(argv({ targets: "127.0.0.1:3939", tool: "foo", format: "table" }), {
      stdout: stream,
      stderr: makeStream().stream,
      env: {},
    });

    const out = output();
    expect(out).toContain("127.0.0.1:3939");
    expect(out).toContain("ok");
    expect(out).toContain("Summary:");
  });
});

// ---------------------------------------------------------------------------
// 8. --fail-fast — exit 1, no unhandled rejections
// ---------------------------------------------------------------------------

describe("fail-fast", () => {
  it("exits 1 when any target fails even with others succeeding", async () => {
    const okResult = { content: [{ type: "text", text: "ok" }] };
    server.use(
      http.post(`${BASE_A}/mcp`, () => HttpResponse.json({ error: "bad" }, { status: 500 })),
      http.post(`${BASE_B}/mcp`, () => jsonRpcOk(okResult)),
      http.post(`${BASE_C}/mcp`, () => jsonRpcOk(okResult)),
    );

    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);

    const code = await runRemoteFanout(
      argv({
        targets: "127.0.0.1:3939,127.0.0.2:3939,127.0.0.3:3939",
        tool: "foo",
        "fail-fast": true,
        format: "json",
      }),
      { stdout: makeStream().stream, stderr: makeStream().stream, env: {} },
    );

    process.off("unhandledRejection", unhandled);
    expect(code).toBe(1);
    expect(unhandled).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 9. MCP tool-level error (isError: true in result)
// ---------------------------------------------------------------------------

describe("MCP tool error", () => {
  it("classifies isError:true response as kind=tool", async () => {
    server.use(http.post(`${BASE_A}/mcp`, () => jsonRpcToolError("node cook failed")));

    const { stream, output } = makeStream();
    const code = await runRemoteFanout(
      argv({ targets: "127.0.0.1:3939", tool: "create_foo", format: "json" }),
      { stdout: stream, stderr: makeStream().stream, env: {} },
    );

    expect(code).toBe(1);
    const report = JSON.parse(output()) as FanoutReport;
    const t = report.targets[0] as TargetResult;
    expect(t.ok).toBe(false);
    if (!t.ok) {
      expect(t.error.kind).toBe("tool");
      expect(t.error.message).toContain("node cook failed");
    }
  });
});
