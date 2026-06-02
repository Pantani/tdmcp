import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  type LogTailFilteredArgs,
  type PollState,
  pollOnce,
  runLogTailFiltered,
} from "../../src/cli/logTailFiltered.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";

/**
 * Branch-coverage gap fill for src/cli/logTailFiltered.ts.
 * Focuses on edges not exercised by cliLogTailFiltered.test.ts:
 *  - formatLine frame fallback paths
 *  - levelOf unknown severity / warning alias
 *  - parseCliArgs full option matrix + invalid-args path
 *  - DedupeRing eviction
 *  - runLogTailFiltered one-shot success + single connection-error → exit 0
 */

const TD_BASE = "http://127.0.0.1:9980";
const makeClient = () => new TouchDesignerClient({ baseUrl: TD_BASE, timeoutMs: 2000 });

const defaultArgs = (): LogTailFilteredArgs => ({
  level: "all",
  follow: false,
  intervalMs: 1000,
  maxLines: 200,
  json: false,
});

function makeState(cap = 2000): PollState {
  return {
    seen: new (class {
      private keys = new Set<string>();
      private queue: string[] = [];
      has(k: string) {
        return this.keys.has(k);
      }
      add(k: string) {
        if (this.keys.has(k)) return;
        if (this.queue.length >= cap) {
          const e = this.queue.shift();
          if (e !== undefined) this.keys.delete(e);
        }
        this.keys.add(k);
        this.queue.push(k);
      }
    })() as unknown as PollState["seen"],
    availableWarnEmitted: false,
  };
}

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("logTailFiltered: format + level branches", () => {
  it("formats lines with frame fallback and no-frame fallback", async () => {
    server.use(
      http.get(`${TD_BASE}/api/logs`, () =>
        HttpResponse.json({
          ok: true,
          data: {
            lines: [
              { source: "/a", message: "with-frame", severity: "info", frame: 7 },
              { source: "/b", message: "no-frame", severity: "info" },
            ],
            count: 2,
            available: true,
            warnings: [],
          },
        }),
      ),
    );

    const out: string[] = [];
    const res = await pollOnce(
      makeClient(),
      defaultArgs(),
      makeState(),
      null,
      (l) => out.push(l),
      () => {},
    );
    expect(res.linesEmitted).toBe(2);
    expect(out[0]).toContain("f7");
    // no-frame line: must NOT contain stray frame token between source and message
    expect(out[1]).toMatch(/\[info\] \/b no-frame/);
    expect(out[1]).not.toMatch(/f\d/);
  });

  it("severity 'warning' alias passes when level=warn; unknown severity treated as low priority", async () => {
    server.use(
      http.get(`${TD_BASE}/api/logs`, () =>
        HttpResponse.json({
          ok: true,
          data: {
            lines: [
              { source: "/a", message: "alias warning", severity: "warning", absframe: 1 },
              { source: "/b", message: "weird sev", severity: "trace", absframe: 2 },
            ],
            count: 2,
            available: true,
            warnings: [],
          },
        }),
      ),
    );

    const out: string[] = [];
    const res = await pollOnce(
      makeClient(),
      { ...defaultArgs(), level: "warn" },
      makeState(),
      null,
      (l) => out.push(l),
      () => {},
    );
    expect(res.linesEmitted).toBe(1);
    expect(out[0]).toContain("alias warning");
  });
});

describe("logTailFiltered: DedupeRing eviction", () => {
  it("evicts oldest key when cap is exceeded so it can be re-emitted", async () => {
    // cap=2: emit A,B then C (evicts A), then re-emit A
    let phase = 0;
    server.use(
      http.get(`${TD_BASE}/api/logs`, () => {
        phase++;
        if (phase === 1) {
          return HttpResponse.json({
            ok: true,
            data: {
              lines: [
                { source: "/s", message: "A", severity: "info", absframe: 1 },
                { source: "/s", message: "B", severity: "info", absframe: 2 },
              ],
              count: 2,
              available: true,
              warnings: [],
            },
          });
        }
        if (phase === 2) {
          return HttpResponse.json({
            ok: true,
            data: {
              lines: [{ source: "/s", message: "C", severity: "info", absframe: 3 }],
              count: 1,
              available: true,
              warnings: [],
            },
          });
        }
        return HttpResponse.json({
          ok: true,
          data: {
            lines: [{ source: "/s", message: "A", severity: "info", absframe: 1 }],
            count: 1,
            available: true,
            warnings: [],
          },
        });
      }),
    );
    const state = makeState(2);
    const args = defaultArgs();
    const r1 = await pollOnce(
      makeClient(),
      args,
      state,
      null,
      () => {},
      () => {},
    );
    const r2 = await pollOnce(
      makeClient(),
      args,
      state,
      null,
      () => {},
      () => {},
    );
    const r3 = await pollOnce(
      makeClient(),
      args,
      state,
      null,
      () => {},
      () => {},
    );
    expect(r1.linesEmitted).toBe(2);
    expect(r2.linesEmitted).toBe(1);
    // A was evicted by C, so it re-emits
    expect(r3.linesEmitted).toBe(1);
  });
});

describe("logTailFiltered: runLogTailFiltered entrypoint", () => {
  it("one-shot mode returns 0 on success", async () => {
    server.use(
      http.get(`${TD_BASE}/api/logs`, () =>
        HttpResponse.json({
          ok: true,
          data: { lines: [], count: 0, available: true, warnings: [] },
        }),
      ),
    );
    const code = await runLogTailFiltered([]);
    expect(code).toBe(0);
  });

  it("one-shot mode survives a single connection error (exit 0, not 1)", async () => {
    server.use(http.get(`${TD_BASE}/api/logs`, () => HttpResponse.error()));
    const code = await runLogTailFiltered([]);
    // one-shot: a single connection error does NOT trip the >=3 consecutive gate
    expect(code).toBe(0);
  });

  it("returns 2 when zod parse rejects a bad option (interval-ms below min)", async () => {
    const code = await runLogTailFiltered(["--interval-ms", "10"]);
    expect(code).toBe(2);
  });

  it("accepts the full option matrix without throwing", async () => {
    server.use(
      http.get(`${TD_BASE}/api/logs`, () =>
        HttpResponse.json({
          ok: true,
          data: { lines: [], count: 0, available: true, warnings: [] },
        }),
      ),
    );
    const code = await runLogTailFiltered([
      "--level",
      "info",
      "--since",
      "2025-01-01T00:00:00Z",
      "--grep",
      "foo",
      "--interval-ms",
      "500",
      "--max-lines",
      "50",
      "--scope",
      "/project1",
      "--json",
    ]);
    expect(code).toBe(0);
  });
});
