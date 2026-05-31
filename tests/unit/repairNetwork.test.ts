import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  buildRepairNetworkScript,
  repairNetworkImpl,
  repairNetworkSchema,
} from "../../src/tools/layer3/repairNetwork.js";
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

/** Pull the JSON payload back out of a captured /api/exec script body. */
function decodePayload(scriptBody: string): Record<string, unknown> {
  const m = scriptBody.match(/b64decode\("([^"]+)"\)/);
  if (!m?.[1]) throw new Error("no base64 payload in script");
  return JSON.parse(Buffer.from(m[1], "base64").toString("utf8"));
}

/** Stub /api/exec to capture the script and return a canned report stdout. */
function stubExec(report: unknown, sink?: (script: string) => void) {
  server.use(
    http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
      const body = (await request.json()) as { script?: string; code?: string };
      const script = body.script ?? body.code ?? "";
      sink?.(script);
      return HttpResponse.json({
        ok: true,
        data: { result: null, stdout: JSON.stringify(report) },
      });
    }),
  );
}

/** A canned report for a subtree with two erroring nodes. */
function reportWith(opts: {
  dry_run: boolean;
  before: number;
  after: number;
  steps: Array<{ node: string; error: string; kind: string; applied: boolean }>;
  remaining: Array<{ node: string; error: string }>;
}) {
  return {
    parent_path: "/project1",
    dry_run: opts.dry_run,
    max_steps: 3,
    errors_before: opts.before,
    errors_after: opts.after,
    steps: opts.steps.map((s) => ({ ...s, planned_fix: "x" })),
    remaining: opts.remaining,
    warnings: [],
  };
}

describe("repair_network", () => {
  it("schema defaults are bounded + dry-run by default", () => {
    const parsed = repairNetworkSchema.parse({});
    expect(parsed.parent_path).toBe("/project1");
    expect(parsed.max_steps).toBe(3);
    expect(parsed.dry_run).toBe(true);
    // max_steps is hard-capped at 10 and floored at 1.
    expect(() => repairNetworkSchema.parse({ max_steps: 0 })).toThrow();
    expect(() => repairNetworkSchema.parse({ max_steps: 11 })).toThrow();
    // string coercion (CLI args arrive as strings).
    expect(repairNetworkSchema.parse({ max_steps: "5" }).max_steps).toBe(5);
  });

  it("builds the payload with parent_path, max_steps and dry_run", async () => {
    let captured = "";
    stubExec(reportWith({ dry_run: true, before: 0, after: 0, steps: [], remaining: [] }), (s) => {
      captured = s;
    });
    await repairNetworkImpl(makeCtx(), {
      parent_path: "/project1/fx",
      max_steps: 4,
      dry_run: true,
    });
    const payload = decodePayload(captured);
    expect(payload.parent_path).toBe("/project1/fx");
    expect(payload.max_steps).toBe(4);
    expect(payload.dry_run).toBe(true);
  });

  it("dry_run never applies and reports errors_after == errors_before", async () => {
    stubExec(
      reportWith({
        dry_run: true,
        before: 2,
        after: 2,
        steps: [
          {
            node: "/project1/noise1",
            error: "invalid expression",
            kind: "clear_expression",
            applied: false,
          },
          {
            node: "/project1/text1",
            error: "syntax error",
            kind: "note",
            applied: false,
          },
        ],
        remaining: [
          { node: "/project1/noise1", error: "invalid expression" },
          { node: "/project1/text1", error: "syntax error" },
        ],
      }),
    );
    const res = await repairNetworkImpl(makeCtx(), {
      parent_path: "/project1",
      max_steps: 3,
      dry_run: true,
    });
    expect(res.isError).toBeFalsy();
    const data = JSON.parse(structured(res));
    expect(data.dry_run).toBe(true);
    expect(data.errors_after).toBe(data.errors_before);
    expect(data.steps.every((s: { applied: boolean }) => s.applied === false)).toBe(true);
  });

  it("max_steps caps the number of steps", async () => {
    // Bridge already honors the cap; assert the impl surfaces a capped array and
    // forwards the bound in the payload.
    let captured = "";
    stubExec(
      reportWith({
        dry_run: true,
        before: 5,
        after: 5,
        steps: [
          { node: "/p/a", error: "e", kind: "note", applied: false },
          { node: "/p/b", error: "e", kind: "note", applied: false },
        ],
        remaining: [],
      }),
      (s) => {
        captured = s;
      },
    );
    const res = await repairNetworkImpl(makeCtx(), {
      parent_path: "/project1",
      max_steps: 2,
      dry_run: true,
    });
    const payload = decodePayload(captured);
    expect(payload.max_steps).toBe(2);
    const data = JSON.parse(structured(res));
    expect(data.steps.length).toBeLessThanOrEqual(2);
  });

  it("dry_run=false applies safe fixes and lowers errors_after", async () => {
    stubExec(
      reportWith({
        dry_run: false,
        before: 2,
        after: 1,
        steps: [
          {
            node: "/project1/noise1",
            error: "invalid expression",
            kind: "clear_expression",
            applied: true,
          },
          {
            node: "/project1/text1",
            error: "syntax error",
            kind: "note",
            applied: false,
          },
        ],
        remaining: [{ node: "/project1/text1", error: "syntax error" }],
      }),
    );
    const res = await repairNetworkImpl(makeCtx(), {
      parent_path: "/project1",
      max_steps: 3,
      dry_run: false,
    });
    expect(res.isError).toBeFalsy();
    const data = JSON.parse(structured(res));
    expect(data.errors_after).toBeLessThan(data.errors_before);
    expect(data.steps.some((s: { applied: boolean }) => s.applied === true)).toBe(true);
    // The risky note stays unapplied even with dry_run=false.
    const note = data.steps.find((s: { kind: string }) => s.kind === "note");
    expect(note.applied).toBe(false);
  });

  it("builds a whole-subtree scan without a hard-coded depth cap", () => {
    const script = buildRepairNetworkScript({
      parent_path: "/project1",
      max_steps: 3,
      dry_run: true,
    });

    expect(script).not.toContain("findChildren(depth=10)");
    expect(script).toContain("findChildren()");
  });

  it("only clears the parameter identified by an expression error", () => {
    const script = buildRepairNetworkScript({
      parent_path: "/project1",
      max_steps: 3,
      dry_run: false,
    });

    expect(script).toContain("_apply_clear_expression(_o, _msg)");
    expect(script).toContain("expression error did not identify a specific parameter");
  });

  it("does not classify every generic Python NameError as clear_expression", () => {
    const script = buildRepairNetworkScript({
      parent_path: "/project1",
      max_steps: 3,
      dry_run: false,
    });

    expect(script).not.toContain(`("name '" in _low)`);
    expect(script).toContain('"name \'" in _low and');
  });

  it("a clean network returns errors_before:0 and no steps", async () => {
    stubExec(reportWith({ dry_run: true, before: 0, after: 0, steps: [], remaining: [] }));
    const res = await repairNetworkImpl(makeCtx(), {
      parent_path: "/project1",
      max_steps: 3,
      dry_run: true,
    });
    expect(res.isError).toBeFalsy();
    const data = JSON.parse(structured(res));
    expect(data.errors_before).toBe(0);
    expect(data.steps).toEqual([]);
    expect(text(res)).toContain("nothing to repair");
  });

  it("bridge fatal -> isError, never throws", async () => {
    stubExec({
      parent_path: "/nope",
      dry_run: true,
      max_steps: 3,
      errors_before: 0,
      errors_after: 0,
      steps: [],
      remaining: [],
      warnings: [],
      fatal: "Not found: /nope",
    });
    const res = await repairNetworkImpl(makeCtx(), {
      parent_path: "/nope",
      max_steps: 3,
      dry_run: true,
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("repair_network failed");
  });

  it("TD offline -> friendly isError result, never throws", async () => {
    server.use(http.post(`${TD_BASE}/api/exec`, () => HttpResponse.error()));
    const res = await repairNetworkImpl(makeCtx(), {
      parent_path: "/project1",
      max_steps: 3,
      dry_run: true,
    });
    expect(res.isError).toBe(true);
  });
});

/** Read the plain-text block of a CallToolResult. */
function text(res: { content: Array<{ type: string; text?: string }> }): string {
  const block = res.content.find((c) => c.type === "text");
  return block?.text ?? "";
}

/** Extract the JSON fence body from a jsonResult CallToolResult. */
function structured(res: { content: Array<{ type: string; text?: string }> }): string {
  const t = text(res);
  const m = t.match(/```json\n([\s\S]*?)\n```/);
  if (!m?.[1]) throw new Error("no json fence in result text");
  return m[1];
}
