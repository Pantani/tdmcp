import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runLogTailFiltered } from "../../src/cli/logTailFiltered.js";

const TD_BASE = "http://127.0.0.1:9980";

const savedEnv: Record<string, string | undefined> = {};
const TD_ENV_KEYS = [
  "TDMCP_TD_HOST",
  "TDMCP_TD_PORT",
  "TDMCP_TD_SCHEME",
  "TDMCP_BRIDGE_TOKEN",
] as const;

const server = setupServer();
beforeAll(() => {
  for (const k of TD_ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  for (const k of TD_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

let stderrSpy: ReturnType<typeof vi.spyOn>;
let stderrChunks: string[] = [];

beforeEach(() => {
  stderrChunks = [];
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    stderrChunks.push(String(chunk));
    return true;
  }) as never);
});

afterEach(() => {
  stderrSpy.mockRestore();
});

describe("runLogTailFiltered one-shot", () => {
  it("exits 0 with no lines when /api/logs is empty", async () => {
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

  it("emits a line with frame fallback (no absframe) and no frame at all", async () => {
    server.use(
      http.get(`${TD_BASE}/api/logs`, () =>
        HttpResponse.json({
          ok: true,
          data: {
            lines: [
              { source: "/a", message: "with frame", severity: "error", frame: 7 },
              { source: "/b", message: "no frame", severity: "error" },
            ],
            count: 2,
            available: true,
            warnings: [],
          },
        }),
      ),
    );
    const code = await runLogTailFiltered([]);
    expect(code).toBe(0);
    const out = stderrChunks.join("");
    expect(out).toContain("f7");
    expect(out).toContain("with frame");
    expect(out).toContain("no frame");
  });

  it("returns 0 on a single connection error in one-shot mode (single poll attempt)", async () => {
    server.use(
      http.get(`${TD_BASE}/api/logs`, () =>
        HttpResponse.json({ ok: false, error: { message: "x" } }, { status: 500 }),
      ),
    );
    // One-shot: single failed poll yields consecutiveErrors=1, ok=true → returns 0.
    const code = await runLogTailFiltered([]);
    expect(code).toBe(0);
    expect(stderrChunks.join("")).toContain("connection error");
  });

  it("returns 2 on invalid --interval-ms (zod validation)", async () => {
    const code = await runLogTailFiltered(["--interval-ms", "50"]);
    expect(code).toBe(2);
    expect(stderrChunks.join("")).toContain("invalid arguments");
  });

  it("returns 2 on invalid --level enum", async () => {
    const code = await runLogTailFiltered(["--level", "bogus"]);
    expect(code).toBe(2);
  });

  it("returns 2 on invalid --grep regex", async () => {
    const code = await runLogTailFiltered(["--grep", "("]);
    expect(code).toBe(2);
    expect(stderrChunks.join("")).toContain("invalid regex");
  });

  it("--json formats the line as JSON", async () => {
    server.use(
      http.get(`${TD_BASE}/api/logs`, () =>
        HttpResponse.json({
          ok: true,
          data: {
            lines: [{ source: "/a", message: "hello", severity: "error", absframe: 3 }],
            count: 1,
            available: true,
            warnings: [],
          },
        }),
      ),
    );
    const code = await runLogTailFiltered(["--json"]);
    expect(code).toBe(0);
    const lines = stderrChunks.join("").split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    const lastLine = lines[lines.length - 1];
    expect(lastLine).toBeDefined();
    const parsed = JSON.parse(lastLine as string);
    expect(parsed).toMatchObject({ severity: "error", source: "/a", message: "hello", frame: 3 });
  });

  it("--scope, --max-lines, and --grep are accepted and parsed", async () => {
    let receivedUrl = "";
    server.use(
      http.get(`${TD_BASE}/api/logs`, ({ request }) => {
        receivedUrl = request.url;
        return HttpResponse.json({
          ok: true,
          data: { lines: [], count: 0, available: true, warnings: [] },
        });
      }),
    );
    const code = await runLogTailFiltered([
      "--scope",
      "/project1",
      "--max-lines",
      "50",
      "--grep",
      "GLSL",
    ]);
    expect(code).toBe(0);
    expect(receivedUrl).toContain("scope=%2Fproject1");
    expect(receivedUrl).toContain("max_lines=50");
    // grep is a client-side filter; not reflected in the request URL.
  });
});
