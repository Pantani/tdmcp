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

  // PR #38 regression: if creation of the replacement fails, the original
  // must NOT be destroyed. The bridge script now creates at a `<name>__swap_tmp`
  // sibling first and only destroys the original after a successful create.
  it("does not destroy the original when new_type is not creatable", async () => {
    mockExecOnce({
      node_path: "/project1/noise1",
      new_type: "notARealOPType",
      old_type: "noiseTOP",
      // No new_path — replacement was never created at the real name.
      preserved_parameters: [],
      dropped_parameters: [],
      reconnected_inputs: 0,
      reconnected_outputs: 0,
      failed_inputs: [],
      failed_outputs: [],
      warnings: [],
      fatal: "Cannot swap: new_type 'notARealOPType' is not a creatable operator type (NameError)",
    });
    const result = await swapOperatorImpl(makeCtx(), {
      node_path: "/project1/noise1",
      new_type: "notARealOPType",
      preserve_parameters: true,
    });
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Cannot swap");
    expect(text).toContain("not a creatable operator type");
  });

  // PR #38: assert the embedded script does temp-create-before-destroy in the
  // right order (temp create → destroy original → rename temp). This guards
  // the order regardless of bridge response.
  it("embedded script creates a __swap_tmp sibling BEFORE destroying the original", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(
      new URL("../../src/tools/layer3/swapOperator.ts", import.meta.url),
      "utf8",
    );
    const tmpIdx = src.indexOf("__swap_tmp");
    const createIdx = src.indexOf('_parent.create(_p["new_type"], _tmp_name)');
    const destroyIdx = src.indexOf("_old.destroy()");
    const renameIdx = src.indexOf("_new.name = _name");
    expect(tmpIdx).toBeGreaterThan(-1);
    expect(createIdx).toBeGreaterThan(-1);
    expect(destroyIdx).toBeGreaterThan(-1);
    expect(renameIdx).toBeGreaterThan(-1);
    // Order: create temp < destroy old < rename temp.
    expect(createIdx).toBeLessThan(destroyIdx);
    expect(destroyIdx).toBeLessThan(renameIdx);
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
