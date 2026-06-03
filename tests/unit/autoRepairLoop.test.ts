import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { autoRepairLoopImpl, autoRepairLoopSchema } from "../../src/tools/layer2/autoRepairLoop.js";
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

type ErrEntry = { path: string; message: string; type?: string };

/** Queue stateful errors responses; each GET pops the next list. */
function stubErrorsQueue(queue: ErrEntry[][]) {
  let i = 0;
  server.use(
    http.get(`${TD_BASE}/api/network/:seg/errors`, () => {
      const errors = queue[Math.min(i, queue.length - 1)] ?? [];
      i += 1;
      return HttpResponse.json({ ok: true, data: { errors } });
    }),
  );
  return {
    callCount: () => i,
  };
}

/** Stub /api/exec with a canned repair_network report and count invocations. */
function stubRepair(reportFor: (callIdx: number) => unknown) {
  let calls = 0;
  server.use(
    http.post(`${TD_BASE}/api/exec`, async () => {
      const rep = reportFor(calls);
      calls += 1;
      return HttpResponse.json({
        ok: true,
        data: { result: null, stdout: JSON.stringify(rep) },
      });
    }),
  );
  return { calls: () => calls };
}

function baseRepairReport(extras: Partial<Record<string, unknown>> = {}) {
  return {
    parent_path: "/project1",
    dry_run: true,
    max_steps: 1,
    errors_before: 0,
    errors_after: 0,
    steps: [],
    remaining: [],
    warnings: [],
    rolled_back: false,
    ...extras,
  };
}

function text(res: { content: Array<{ type: string; text?: string }> }): string {
  const block = res.content.find((c) => c.type === "text");
  return block?.text ?? "";
}

function structured(res: { content: Array<{ type: string; text?: string }> }): {
  status: string;
  iterations: Array<{
    clusters: Array<{ category: string; route: string; invoked: boolean }>;
    errors_before: number;
    errors_after: number;
  }>;
  errors_before: number;
  errors_after: number;
  remaining: Array<{ node: string; error: string; category: string }>;
  recommended_prompts: Array<{ prompt: string; args: Record<string, string>; why: string }>;
  dry_run: boolean;
  warnings: string[];
} {
  const m = text(res).match(/```json\n([\s\S]*?)\n```/);
  if (!m?.[1]) throw new Error("no json fence in result text");
  return JSON.parse(m[1]);
}

describe("auto_repair_loop", () => {
  it("schema defaults: bounded + dry-run + all fixers allowed", () => {
    const parsed = autoRepairLoopSchema.parse({});
    expect(parsed.path).toBe("/project1");
    expect(parsed.max_iterations).toBe(3);
    expect(parsed.dry_run).toBe(true);
    expect(parsed.min_progress).toBe(1);
    expect(parsed.include_warnings).toBe(false);
    expect(parsed.allowed_fixers).toContain("repair_network");
    expect(parsed.allowed_fixers).toContain("fix_shader");
    expect(() => autoRepairLoopSchema.parse({ max_iterations: 0 })).toThrow();
    expect(() => autoRepairLoopSchema.parse({ max_iterations: 9 })).toThrow();
  });

  it("clean on entry -> status:clean, no repair_network call", async () => {
    stubErrorsQueue([[]]);
    const ex = stubRepair(() => baseRepairReport());
    const res = await autoRepairLoopImpl(makeCtx(), {
      path: "/project1",
      max_iterations: 3,
      dry_run: false,
      allowed_fixers: ["repair_network", "fix_shader", "fix_reactivity", "summarize_td_errors"],
      min_progress: 1,
      include_warnings: false,
    });
    const data = structured(res);
    expect(data.status).toBe("clean");
    expect(data.errors_before).toBe(0);
    expect(data.errors_after).toBe(0);
    expect(ex.calls()).toBe(0);
  });

  it("shader-only cluster -> prompt hand-off, no repair_network", async () => {
    stubErrorsQueue([
      [
        {
          path: "/project1/glsl1",
          message: "ERROR: 0:12: 'fragColor' undeclared",
          type: "glsl",
        },
      ],
      // second GET (errors_after) returns same — but loop is dry_run so it won't iterate again
      [
        {
          path: "/project1/glsl1",
          message: "ERROR: 0:12: 'fragColor' undeclared",
          type: "glsl",
        },
      ],
    ]);
    const ex = stubRepair(() => baseRepairReport());
    const res = await autoRepairLoopImpl(makeCtx(), {
      path: "/project1",
      max_iterations: 3,
      dry_run: true,
      allowed_fixers: ["repair_network", "fix_shader", "fix_reactivity", "summarize_td_errors"],
      min_progress: 1,
      include_warnings: false,
    });
    const data = structured(res);
    expect(ex.calls()).toBe(0);
    expect(data.recommended_prompts[0]?.prompt).toBe("fix_shader");
    expect(data.iterations[0]?.clusters[0]?.category).toBe("shader_compile");
    expect(data.iterations[0]?.clusters[0]?.invoked).toBe(false);
    expect(data.status).toBe("planned");
  });

  it("expression cluster + dry_run -> one iteration, repair called with dry_run:true,max_steps:1", async () => {
    stubErrorsQueue([
      [{ path: "/project1/noise1", message: "invalid expression in par 'tx'" }],
      [{ path: "/project1/noise1", message: "invalid expression in par 'tx'" }],
    ]);
    let captured: { dry_run?: boolean; max_steps?: number } = {};
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: string; code?: string };
        const script = body.script ?? body.code ?? "";
        const m = script.match(/b64decode\("([^"]+)"\)/);
        if (m?.[1]) {
          captured = JSON.parse(Buffer.from(m[1], "base64").toString("utf8"));
        }
        return HttpResponse.json({
          ok: true,
          data: {
            result: null,
            stdout: JSON.stringify(
              baseRepairReport({ dry_run: true, errors_before: 1, errors_after: 1, steps: [] }),
            ),
          },
        });
      }),
    );
    const res = await autoRepairLoopImpl(makeCtx(), {
      path: "/project1",
      max_iterations: 3,
      dry_run: true,
      allowed_fixers: ["repair_network", "fix_shader", "fix_reactivity", "summarize_td_errors"],
      min_progress: 1,
      include_warnings: false,
    });
    const data = structured(res);
    expect(captured.dry_run).toBe(true);
    expect(captured.max_steps).toBe(1);
    expect(data.iterations).toHaveLength(1);
    expect(data.status).toBe("planned");
  });

  it("expression cluster, errors drop 5->2->0 -> three iterations, status:clean", async () => {
    const five: ErrEntry[] = Array.from({ length: 5 }, (_, n) => ({
      path: `/project1/noise${n + 1}`,
      message: "invalid expression in par 'tx'",
    }));
    const two: ErrEntry[] = five.slice(0, 2);
    // iter1: before=5, after=2; iter2: before=2, after=0
    stubErrorsQueue([five, two, two, []]);
    stubRepair((i) =>
      baseRepairReport({
        dry_run: false,
        errors_before: i === 0 ? 5 : 2,
        errors_after: i === 0 ? 2 : 0,
        steps: [
          {
            node: "/project1/n",
            error: "x",
            planned_fix: "y",
            kind: "clear_expression",
            applied: true,
          },
        ],
      }),
    );
    const res = await autoRepairLoopImpl(makeCtx(), {
      path: "/project1",
      max_iterations: 3,
      dry_run: false,
      allowed_fixers: ["repair_network", "fix_shader", "fix_reactivity", "summarize_td_errors"],
      min_progress: 1,
      include_warnings: false,
    });
    const data = structured(res);
    expect(data.status).toBe("clean");
    expect(data.errors_before).toBe(5);
    expect(data.errors_after).toBe(0);
    expect(data.iterations.length).toBeGreaterThanOrEqual(2);
  });

  it("stalled: errors stay at 5 across iterations -> status:stalled", async () => {
    const five: ErrEntry[] = Array.from({ length: 5 }, (_, n) => ({
      path: `/project1/noise${n + 1}`,
      message: "invalid expression in par 'tx'",
    }));
    stubErrorsQueue([five, five, five, five]);
    stubRepair(() =>
      baseRepairReport({ dry_run: false, errors_before: 5, errors_after: 5, steps: [] }),
    );
    const res = await autoRepairLoopImpl(makeCtx(), {
      path: "/project1",
      max_iterations: 3,
      dry_run: false,
      allowed_fixers: ["repair_network", "fix_shader", "fix_reactivity", "summarize_td_errors"],
      min_progress: 1,
      include_warnings: false,
    });
    const data = structured(res);
    expect(data.status).toBe("stalled");
    expect(data.errors_after).toBe(5);
  });

  it("exhausted: drops by 1 per iter with max_iterations:2", async () => {
    const make = (n: number): ErrEntry[] =>
      Array.from({ length: n }, (_, k) => ({
        path: `/project1/noise${k + 1}`,
        message: "invalid expression in par 'tx'",
      }));
    // iter1 before=5,after=4; iter2 before=4,after=3
    stubErrorsQueue([make(5), make(4), make(4), make(3)]);
    let n = 5;
    stubRepair(() => {
      const r = baseRepairReport({ dry_run: false, errors_before: n, errors_after: n - 1 });
      n -= 1;
      return r;
    });
    const res = await autoRepairLoopImpl(makeCtx(), {
      path: "/project1",
      max_iterations: 2,
      dry_run: false,
      allowed_fixers: ["repair_network", "fix_shader", "fix_reactivity", "summarize_td_errors"],
      min_progress: 1,
      include_warnings: false,
    });
    const data = structured(res);
    expect(data.status).toBe("exhausted");
    expect(data.iterations).toHaveLength(2);
    expect(data.errors_after).toBe(3);
  });

  it("allowed_fixers without repair_network -> advisory; no exec call; remaining surfaces structural", async () => {
    stubErrorsQueue([
      [
        { path: "/project1/glsl1", message: "ERROR: 0:5: bad", type: "glsl" },
        { path: "/project1/noise1", message: "invalid expression in par 'tx'" },
      ],
      [
        { path: "/project1/glsl1", message: "ERROR: 0:5: bad", type: "glsl" },
        { path: "/project1/noise1", message: "invalid expression in par 'tx'" },
      ],
    ]);
    const ex = stubRepair(() => baseRepairReport());
    const res = await autoRepairLoopImpl(makeCtx(), {
      path: "/project1",
      max_iterations: 3,
      dry_run: false,
      allowed_fixers: ["fix_shader", "fix_reactivity"],
      min_progress: 1,
      include_warnings: false,
    });
    const data = structured(res);
    expect(ex.calls()).toBe(0);
    expect(data.recommended_prompts.some((p) => p.prompt === "fix_shader")).toBe(true);
    expect(data.remaining.some((r) => r.category === "expression_bad")).toBe(true);
  });

  it("mixed cluster: one shader + one expression -> both surfaces populated", async () => {
    stubErrorsQueue([
      [
        { path: "/project1/glsl1", message: "ERROR: 0:5: bad", type: "glsl" },
        { path: "/project1/noise1", message: "invalid expression in par 'tx'" },
      ],
      [{ path: "/project1/glsl1", message: "ERROR: 0:5: bad", type: "glsl" }],
    ]);
    const ex = stubRepair(() =>
      baseRepairReport({ dry_run: false, errors_before: 2, errors_after: 1 }),
    );
    const res = await autoRepairLoopImpl(makeCtx(), {
      path: "/project1",
      max_iterations: 1,
      dry_run: false,
      allowed_fixers: ["repair_network", "fix_shader", "fix_reactivity", "summarize_td_errors"],
      min_progress: 1,
      include_warnings: false,
    });
    const data = structured(res);
    expect(ex.calls()).toBeGreaterThanOrEqual(1);
    expect(data.recommended_prompts.some((p) => p.prompt === "fix_shader")).toBe(true);
    const cats = data.iterations[0]?.clusters.map((c) => c.category) ?? [];
    expect(cats).toContain("shader_compile");
    expect(cats).toContain("expression_bad");
  });

  it("bridge offline -> friendly isError, never throws", async () => {
    server.use(http.get(`${TD_BASE}/api/network/:seg/errors`, () => HttpResponse.error()));
    const res = await autoRepairLoopImpl(makeCtx(), {
      path: "/project1",
      max_iterations: 3,
      dry_run: true,
      allowed_fixers: ["repair_network", "fix_shader", "fix_reactivity", "summarize_td_errors"],
      min_progress: 1,
      include_warnings: false,
    });
    expect(res.isError).toBe(true);
  });

  it("min_progress:2 with cleared=1 -> status:stalled despite forward motion", async () => {
    const five: ErrEntry[] = Array.from({ length: 5 }, (_, n) => ({
      path: `/project1/noise${n + 1}`,
      message: "invalid expression in par 'tx'",
    }));
    const four = five.slice(0, 4);
    stubErrorsQueue([five, four]);
    stubRepair(() => baseRepairReport({ dry_run: false, errors_before: 5, errors_after: 4 }));
    const res = await autoRepairLoopImpl(makeCtx(), {
      path: "/project1",
      max_iterations: 3,
      dry_run: false,
      allowed_fixers: ["repair_network", "fix_shader", "fix_reactivity", "summarize_td_errors"],
      min_progress: 2,
      include_warnings: false,
    });
    const data = structured(res);
    expect(data.status).toBe("stalled");
    expect(data.errors_after).toBe(4);
  });
});
