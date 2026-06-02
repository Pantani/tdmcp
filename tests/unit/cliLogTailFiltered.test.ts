import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  type LogTailFilteredArgs,
  type PollState,
  pollOnce,
} from "../../src/cli/logTailFiltered.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";

// We need to export DedupeRing — patch: use the exported PollState factory instead
// by importing pollOnce and constructing PollState manually via a helper.

const TD_BASE = "http://127.0.0.1:9980";

const makeClient = () => new TouchDesignerClient({ baseUrl: TD_BASE, timeoutMs: 2000 });

const defaultArgs = (): LogTailFilteredArgs => ({
  level: "all",
  follow: false,
  intervalMs: 1000,
  maxLines: 200,
  json: false,
});

// msw server with default /api/logs handler (overridden per test).
const server = setupServer(
  http.get(`${TD_BASE}/api/logs`, () =>
    HttpResponse.json({
      ok: true,
      data: {
        lines: [],
        count: 0,
        available: true,
        warnings: [],
      },
    }),
  ),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// Helper: make a fresh PollState using the internal DedupeRing shape.
function makeState(): PollState {
  // Construct by matching the exported PollState interface shape.
  return {
    seen: new (class {
      private keys = new Set<string>();
      private queue: string[] = [];
      private cap = 2000;
      has(k: string) {
        return this.keys.has(k);
      }
      add(k: string) {
        if (this.keys.has(k)) return;
        if (this.queue.length >= this.cap) {
          const e = this.queue.shift();
          if (e !== undefined) this.keys.delete(e);
        }
        this.keys.add(k);
        this.queue.push(k);
      }
    })() as unknown as import("../../src/cli/logTailFiltered.js").PollState["seen"],
    availableWarnEmitted: false,
  };
}

// Re-import pollOnce with a simplified minimal client interface for testing.
// We use the real TouchDesignerClient + msw for the happy paths.

describe("log-tail CLI: pollOnce", () => {
  it("one-shot emits only error lines when level=error", async () => {
    server.use(
      http.get(`${TD_BASE}/api/logs`, () =>
        HttpResponse.json({
          ok: true,
          data: {
            lines: [
              { source: "/op1", message: "GLSL compile error", severity: "error", absframe: 100 },
              { source: "/op2", message: "warn about perf", severity: "warn", absframe: 101 },
              { source: "/op3", message: "another warning", severity: "warning", absframe: 102 },
            ],
            count: 3,
            available: true,
            warnings: [],
          },
        }),
      ),
    );

    const lines: string[] = [];
    const warns: string[] = [];
    const state = makeState();
    const res = await pollOnce(
      makeClient(),
      { ...defaultArgs(), level: "error" },
      state,
      null,
      (l) => lines.push(l),
      (w) => warns.push(w),
    );

    expect(res.connectionError).toBe(false);
    expect(res.linesEmitted).toBe(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("GLSL compile error");
    expect(lines[0]).toContain("[error]");
  });

  it("--grep filters by regex", async () => {
    server.use(
      http.get(`${TD_BASE}/api/logs`, () =>
        HttpResponse.json({
          ok: true,
          data: {
            lines: [
              { source: "/op1", message: "GLSL compile error", severity: "error", absframe: 1 },
              { source: "/op2", message: "cook time exceeded", severity: "warn", absframe: 2 },
              { source: "/op3", message: "GLSL link error", severity: "error", absframe: 3 },
              { source: "/op4", message: "info message", severity: "info", absframe: 4 },
            ],
            count: 4,
            available: true,
            warnings: [],
          },
        }),
      ),
    );

    const lines: string[] = [];
    const state = makeState();
    const res = await pollOnce(
      makeClient(),
      defaultArgs(),
      state,
      /GLSL/,
      (l) => lines.push(l),
      () => {},
    );

    expect(res.linesEmitted).toBe(2);
    expect(lines.every((l) => l.includes("GLSL"))).toBe(true);
  });

  it("dedupe: second poll with same lines emits 0", async () => {
    const sameLines = [
      { source: "/op1", message: "error A", severity: "error", absframe: 10 },
      { source: "/op2", message: "error B", severity: "error", absframe: 11 },
    ];
    server.use(
      http.get(`${TD_BASE}/api/logs`, () =>
        HttpResponse.json({
          ok: true,
          data: { lines: sameLines, count: 2, available: true, warnings: [] },
        }),
      ),
    );

    const state = makeState();
    const args = defaultArgs();

    const res1 = await pollOnce(
      makeClient(),
      args,
      state,
      null,
      () => {},
      () => {},
    );
    expect(res1.linesEmitted).toBe(2);

    const res2 = await pollOnce(
      makeClient(),
      args,
      state,
      null,
      () => {},
      () => {},
    );
    expect(res2.linesEmitted).toBe(0);
  });

  it("invalid regex returns exit 2 via runLogTailFiltered", async () => {
    // Test at the entry-point level using the runLogTailFiltered function.
    // We need to mock loadConfig and the client — instead, test via a short-circuit:
    // runLogTailFiltered should return 2 before any I/O when grep is invalid.
    const { runLogTailFiltered } = await import("../../src/cli/logTailFiltered.js");
    const stderrChunks: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      stderrChunks.push(String(chunk));
      return true;
    }) as never);
    try {
      const code = await runLogTailFiltered(["--grep", "("]);
      expect(code).toBe(2);
      expect(stderrChunks.join("")).toContain("invalid regex");
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("available=false warning emitted exactly once across two polls", async () => {
    let callCount = 0;
    server.use(
      http.get(`${TD_BASE}/api/logs`, () => {
        callCount++;
        if (callCount === 1) {
          return HttpResponse.json({
            ok: true,
            data: { lines: [], count: 0, available: false, warnings: [] },
          });
        }
        return HttpResponse.json({
          ok: true,
          data: {
            lines: [{ source: "/op1", message: "new line", severity: "info", absframe: 50 }],
            count: 1,
            available: true,
            warnings: [],
          },
        });
      }),
    );

    const warns: string[] = [];
    const state = makeState();
    const args = defaultArgs();
    const onWarn = (w: string) => warns.push(w);

    await pollOnce(makeClient(), args, state, null, () => {}, onWarn);
    await pollOnce(makeClient(), args, state, null, () => {}, onWarn);

    expect(warns.filter((w) => w.includes("unavailable"))).toHaveLength(1);
  });

  it("--json mode emits parseable JSON with required keys", async () => {
    server.use(
      http.get(`${TD_BASE}/api/logs`, () =>
        HttpResponse.json({
          ok: true,
          data: {
            lines: [{ source: "/op1", message: "test msg", severity: "error", absframe: 5 }],
            count: 1,
            available: true,
            warnings: [],
          },
        }),
      ),
    );

    const lines: string[] = [];
    const state = makeState();
    await pollOnce(
      makeClient(),
      { ...defaultArgs(), json: true },
      state,
      null,
      (l) => lines.push(l),
      () => {},
    );

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]?.trim() ?? "null");
    expect(parsed).toHaveProperty("severity");
    expect(parsed).toHaveProperty("source");
    expect(parsed).toHaveProperty("message");
  });

  it("TD offline: connection error returns connectionError=true", async () => {
    server.use(
      http.get(`${TD_BASE}/api/logs`, () =>
        HttpResponse.json({ ok: false, error: { message: "bridge down" } }, { status: 500 }),
      ),
    );

    const state = makeState();
    const res = await pollOnce(
      makeClient(),
      defaultArgs(),
      state,
      null,
      () => {},
      () => {},
    );

    expect(res.connectionError).toBe(true);
    expect(res.linesEmitted).toBe(0);
  });
});
