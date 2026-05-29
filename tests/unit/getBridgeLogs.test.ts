import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { getBridgeLogsImpl, getBridgeLogsSchema } from "../../src/tools/layer3/getBridgeLogs.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

const server = makeTdServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function makeCtx(): ToolContext {
  return {
    client: new TouchDesignerClient({ baseUrl: TD_BASE, timeoutMs: 2000 }),
    knowledge: new KnowledgeBase(),
    recipes: new RecipeLibrary(),
    logger: silentLogger,
  };
}

/** Decode the base64 payload embedded in a captured /api/exec script. */
function decodePayload(script: string): Record<string, unknown> {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (b64 === undefined) throw new Error("no base64 payload in script");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
}

/** Override /api/exec to capture the script and return a crafted JSON report on stdout. */
function captureWithReport(report: unknown): { scripts: string[] } {
  const scripts: string[] = [];
  server.use(
    http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
      const body = (await request.json()) as { script: string };
      scripts.push(body.script);
      return HttpResponse.json({
        ok: true,
        data: { result: null, stdout: `${JSON.stringify(report)}\n` },
      });
    }),
  );
  return { scripts };
}

const HAPPY_REPORT = {
  scope: "/project1",
  lines: [
    { source: "cook", level: "error", text: "Python syntax error", op: "/project1/script1" },
    { source: "cook", level: "warning", text: "Missing input", op: "/project1/blur1" },
  ],
  count: 2,
  probe: { cook_errors_available: true, cook_walk_count: 10, textport_available: false },
  warnings: [],
};

describe("get_bridge_logs", () => {
  describe("schema defaults", () => {
    it("defaults scope to '/', max_lines to 100, include_cook_errors to true", () => {
      const parsed = getBridgeLogsSchema.parse({});
      expect(parsed.scope).toBe("/");
      expect(parsed.max_lines).toBe(100);
      expect(parsed.include_cook_errors).toBe(true);
    });

    it("rejects max_lines below 1", () => {
      expect(() => getBridgeLogsSchema.parse({ max_lines: 0 })).toThrow();
    });

    it("rejects max_lines above 500", () => {
      expect(() => getBridgeLogsSchema.parse({ max_lines: 501 })).toThrow();
    });
  });

  describe("payload encoding", () => {
    it("sends scope, max_lines, and include_cook_errors to the bridge", async () => {
      const { scripts } = captureWithReport(HAPPY_REPORT);
      await getBridgeLogsImpl(makeCtx(), {
        scope: "/project1",
        max_lines: 50,
        include_cook_errors: true,
      });

      expect(scripts).toHaveLength(1);
      const script = scripts[0] ?? "";
      // Script must use the standard base64 decode pattern
      expect(script).toContain("b64decode");
      // Script must walk children and collect errors/warnings
      expect(script).toContain("findChildren");
      expect(script).toContain("errors(");
      expect(script).toContain("warnings(");

      const payload = decodePayload(script);
      expect(payload.scope).toBe("/project1");
      expect(payload.max_lines).toBe(50);
      expect(payload.include_cook_errors).toBe(true);
    });

    it("passes a custom scope through to the payload", async () => {
      const { scripts } = captureWithReport({ ...HAPPY_REPORT, scope: "/project1/fx" });
      await getBridgeLogsImpl(makeCtx(), {
        scope: "/project1/fx",
        max_lines: 100,
        include_cook_errors: true,
      });
      const payload = decodePayload(scripts[0] ?? "");
      expect(payload.scope).toBe("/project1/fx");
    });

    it("passes include_cook_errors:false through to the payload", async () => {
      const { scripts } = captureWithReport({ ...HAPPY_REPORT, lines: [], count: 0 });
      await getBridgeLogsImpl(makeCtx(), {
        scope: "/",
        max_lines: 100,
        include_cook_errors: false,
      });
      const payload = decodePayload(scripts[0] ?? "");
      expect(payload.include_cook_errors).toBe(false);
    });
  });

  describe("happy path", () => {
    it("returns structuredContent with lines, count, probe, and warnings", async () => {
      captureWithReport(HAPPY_REPORT);
      const result = await getBridgeLogsImpl(makeCtx(), {
        scope: "/project1",
        max_lines: 100,
        include_cook_errors: true,
      });
      expect(result.isError).toBeFalsy();

      const data = (
        result as {
          structuredContent?: {
            scope: string;
            lines: Array<{ source: string; level: string; text: string; op?: string }>;
            count: number;
            probe: Record<string, unknown>;
            warnings: string[];
          };
        }
      ).structuredContent;

      expect(data?.scope).toBe("/project1");
      expect(data?.count).toBe(2);
      expect(data?.lines).toHaveLength(2);
      expect(data?.lines[0]?.level).toBe("error");
      expect(data?.lines[0]?.op).toBe("/project1/script1");
      expect(data?.probe?.cook_errors_available).toBe(true);
      expect(data?.warnings).toEqual([]);
    });

    it("writes a friendly one-line summary with scope, error, and warning counts", async () => {
      captureWithReport(HAPPY_REPORT);
      const result = await getBridgeLogsImpl(makeCtx(), {
        scope: "/project1",
        max_lines: 100,
        include_cook_errors: true,
      });
      const text = result.content.find((c) => c.type === "text") as { text: string } | undefined;
      expect(text?.text).toBe("2 log line(s) from /project1 (1 error(s), 1 warning(s)).");
    });

    it("surfaces truncation warnings from the bridge in the output", async () => {
      const reportWithTrunc = {
        ...HAPPY_REPORT,
        lines: [{ source: "cook", level: "error", text: "err", op: "/project1/n1" }],
        count: 1,
        warnings: ["Truncated to 1 of 42 lines."],
      };
      captureWithReport(reportWithTrunc);
      const result = await getBridgeLogsImpl(makeCtx(), {
        scope: "/project1",
        max_lines: 1,
        include_cook_errors: true,
      });
      const data = (result as { structuredContent?: { warnings: string[] } }).structuredContent;
      expect(data?.warnings[0]).toContain("Truncated");
    });
  });

  describe("fatal / error paths", () => {
    it("returns isError (no throw) when the bridge reports a fatal", async () => {
      captureWithReport({
        scope: "/nope",
        lines: [],
        count: 0,
        warnings: [],
        fatal: "Scope operator not found: /nope",
      });
      const result = await getBridgeLogsImpl(makeCtx(), {
        scope: "/nope",
        max_lines: 100,
        include_cook_errors: true,
      });
      expect(result.isError).toBe(true);
      const text = result.content.find((c) => c.type === "text") as { text: string } | undefined;
      expect(text?.text).toContain("Scope operator not found: /nope");
    });

    it("returns isError (no throw) when TD is unreachable", async () => {
      server.use(http.post(`${TD_BASE}/api/exec`, () => HttpResponse.error()));
      const result = await getBridgeLogsImpl(makeCtx(), {
        scope: "/project1",
        max_lines: 100,
        include_cook_errors: true,
      });
      expect(result.isError).toBe(true);
    });

    it("never throws out of the handler even when TD is unreachable", async () => {
      server.use(http.post(`${TD_BASE}/api/exec`, () => HttpResponse.error()));
      await expect(
        getBridgeLogsImpl(makeCtx(), {
          scope: "/",
          max_lines: 100,
          include_cook_errors: true,
        }),
      ).resolves.toBeDefined();
    });
  });

  describe("endpoint-first path (GET /api/logs)", () => {
    it("maps Error-DAT rows into {source:'cook', level, text, op} and never calls exec", async () => {
      let execCalled = false;
      server.use(
        http.get(`${TD_BASE}/api/logs`, () =>
          HttpResponse.json({
            ok: true,
            data: {
              lines: [
                {
                  source: "/project1/moviein1",
                  message: "File not found",
                  severity: "Error",
                  type: "TOP",
                },
              ],
              count: 1,
              error_dat: "/project1/tdmcp_bridge/error_log",
              available: true,
              warnings: [],
            },
          }),
        ),
        http.post(`${TD_BASE}/api/exec`, () => {
          execCalled = true;
          return HttpResponse.json({ ok: true, data: { result: null, stdout: "{}" } });
        }),
      );

      const result = await getBridgeLogsImpl(makeCtx(), {
        scope: "/project1",
        max_lines: 100,
        include_cook_errors: true,
      });

      expect(result.isError).toBeFalsy();
      expect(execCalled).toBe(false);
      const sc = result.structuredContent as {
        lines: Array<{ source: string; level: string; text: string; op?: string }>;
        count: number;
      };
      expect(sc.count).toBe(1);
      expect(sc.lines[0]).toMatchObject({
        source: "cook",
        level: "error",
        text: "File not found",
        op: "/project1/moviein1",
      });
    });

    it("falls back to the exec op-walk when the endpoint reports available:false", async () => {
      let execCalled = false;
      server.use(
        http.get(`${TD_BASE}/api/logs`, () =>
          HttpResponse.json({
            ok: true,
            data: { lines: [], count: 0, available: false, warnings: ["Error DAT not found"] },
          }),
        ),
        http.post(`${TD_BASE}/api/exec`, () => {
          execCalled = true;
          return HttpResponse.json({
            ok: true,
            data: {
              result: null,
              stdout: JSON.stringify({
                scope: "/project1",
                lines: [],
                count: 0,
                probe: { cook_errors_available: true },
                warnings: [],
              }),
            },
          });
        }),
      );

      const result = await getBridgeLogsImpl(makeCtx(), {
        scope: "/project1",
        max_lines: 100,
        include_cook_errors: true,
      });

      expect(result.isError).toBeFalsy();
      expect(execCalled).toBe(true);
    });
  });
});
