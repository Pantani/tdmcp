import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { swapOperatorImpl } from "../../src/tools/layer3/swapOperator.js";
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

const ok = (data: unknown) => HttpResponse.json({ ok: true, data });

function jsonOf(result: { content: unknown[] }) {
  const text = (result.content[0] as { text: string }).text;
  const m = text.match(/```json\n([\s\S]*?)\n```/);
  if (!m?.[1]) throw new Error(`no json: ${text}`);
  return JSON.parse(m[1]);
}

function mockExecOnce(report: Record<string, unknown>) {
  server.use(
    http.post(`${TD_BASE}/api/exec`, () =>
      ok({ result: null, stdout: `${JSON.stringify(report)}\n` }),
    ),
  );
}

describe("swapOperatorImpl", () => {
  it("reports preserved params and reconnected wires", async () => {
    mockExecOnce({
      node_path: "/project1/noise1",
      new_type: "rampTOP",
      old_type: "noiseTOP",
      new_path: "/project1/noise1",
      preserved_parameters: ["resolutionw", "resolutionh"],
      dropped_parameters: ["period"],
      reconnected_inputs: 1,
      reconnected_outputs: 2,
      failed_inputs: [],
      failed_outputs: [],
      warnings: [],
    });
    const result = await swapOperatorImpl(makeCtx(), {
      node_path: "/project1/noise1",
      new_type: "rampTOP",
      preserve_parameters: true,
    });
    expect(result.isError).toBeFalsy();
    const r = jsonOf(result);
    expect(r.preserved_parameters).toContain("resolutionw");
    expect(r.dropped_parameters).toContain("period");
    expect(r.reconnected_inputs).toBe(1);
  });

  it("surfaces a fatal as an error result", async () => {
    mockExecOnce({
      node_path: "/project1/nope",
      new_type: "rampTOP",
      fatal: "Node not found: /project1/nope",
      warnings: [],
    });
    const result = await swapOperatorImpl(makeCtx(), {
      node_path: "/project1/nope",
      new_type: "rampTOP",
      preserve_parameters: true,
    });
    expect(result.isError).toBe(true);
  });

  it("warns when the requested type is unknown to the knowledge base", async () => {
    mockExecOnce({
      node_path: "/project1/noise1",
      new_type: "totallyMadeUpTOP",
      old_type: "noiseTOP",
      new_path: "/project1/noise1",
      preserved_parameters: [],
      dropped_parameters: [],
      reconnected_inputs: 0,
      reconnected_outputs: 0,
      failed_inputs: [],
      failed_outputs: [],
      warnings: [],
    });
    const result = await swapOperatorImpl(makeCtx(), {
      node_path: "/project1/noise1",
      new_type: "totallyMadeUpTOP",
      preserve_parameters: true,
    });
    // The KB-warning surfaces non-fatally; mock returns a successful "swap" so
    // result.isError is falsy, but the warning string is in the report.
    const r = jsonOf(result);
    expect((r.warnings as string[]).some((w) => w.includes("totallyMadeUpTOP"))).toBe(true);
  });
});
