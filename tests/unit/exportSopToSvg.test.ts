import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { exportSopToSvgImpl } from "../../src/tools/layer3/exportSopToSvg.js";
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

describe("exportSopToSvgImpl", () => {
  it("emits an SVG with one polyline per primitive", async () => {
    mockExecOnce({
      source_path: "/project1/geo1/circle1",
      point_count: 4,
      prim_count: 1,
      polylines: [
        [
          [0, 0, 0],
          [1, 0, 0],
          [1, 1, 0],
          [0, 1, 0],
        ],
      ],
      warnings: [],
    });
    const result = await exportSopToSvgImpl(makeCtx(), {
      source_path: "/project1/geo1/circle1",
      stroke_color: "#000",
      stroke_width: 1,
      fill_color: "none",
      scale: 100,
      flip_y: true,
    });
    expect(result.isError).toBeFalsy();
    const r = jsonOf(result);
    expect(r.polyline_count).toBe(1);
    expect(r.svg).toContain("<polyline");
    expect(r.svg).toContain("viewBox=");
  });

  it("returns an error when the SOP cannot be found (fatal)", async () => {
    mockExecOnce({
      source_path: "/nope",
      fatal: "SOP not found: /nope",
      polylines: [],
    });
    const result = await exportSopToSvgImpl(makeCtx(), {
      source_path: "/nope",
      stroke_color: "#000",
      stroke_width: 1,
      fill_color: "none",
      scale: 100,
      flip_y: true,
    });
    expect(result.isError).toBe(true);
  });

  it("handles an empty SOP gracefully (no polylines)", async () => {
    mockExecOnce({
      source_path: "/project1/empty",
      point_count: 0,
      prim_count: 0,
      polylines: [],
      warnings: [],
    });
    const result = await exportSopToSvgImpl(makeCtx(), {
      source_path: "/project1/empty",
      stroke_color: "#000",
      stroke_width: 1,
      fill_color: "none",
      scale: 100,
      flip_y: true,
    });
    expect(result.isError).toBeFalsy();
    const r = jsonOf(result);
    expect(r.polyline_count).toBe(0);
    expect(r.svg).toContain("<svg");
  });
});
