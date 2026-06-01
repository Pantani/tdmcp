import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { exportSopToSvgImpl, exportSopToSvgSchema } from "../../src/tools/layer3/exportSopToSvg.js";
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

  describe("color attribute injection defence", () => {
    // Schema-level allowlist: an attacker-supplied colour with quotes / angle
    // brackets / handlers must be rejected before the impl ever runs, so it
    // cannot break out of the SVG attribute.
    it("rejects stroke_color values that could break out of an SVG attribute", () => {
      const bad = [
        'red" onload="alert(1)',
        '#fff"><script>alert(1)</script>',
        "red; fill: url(javascript:alert(1))",
        "<img src=x>",
        'rgb(0,0,0)" onload="x',
      ];
      for (const value of bad) {
        const parsed = exportSopToSvgSchema.safeParse({
          source_path: "/project1/empty",
          stroke_color: value,
        });
        expect(parsed.success, `should reject stroke_color=${JSON.stringify(value)}`).toBe(false);
      }
    });

    it("rejects fill_color values that could break out of an SVG attribute", () => {
      const parsed = exportSopToSvgSchema.safeParse({
        source_path: "/project1/empty",
        fill_color: 'none" onload="alert(1)',
      });
      expect(parsed.success).toBe(false);
    });

    it("accepts the standard CSS color forms", () => {
      for (const value of [
        "#000",
        "#ffffff",
        "#11223344",
        "red",
        "none",
        "transparent",
        "rgb(10, 20, 30)",
        "rgba(10, 20, 30, 0.5)",
        "hsl(120, 50%, 50%)",
      ]) {
        const parsed = exportSopToSvgSchema.safeParse({
          source_path: "/project1/empty",
          stroke_color: value,
          fill_color: value,
        });
        expect(parsed.success, `should accept ${JSON.stringify(value)}`).toBe(true);
      }
    });

    // Defence in depth: even when a permissive value sneaks through (e.g. if
    // the regex is ever widened), the generated SVG must never contain a raw
    // quote inside an attribute value.
    it("escapes any quote/angle-bracket characters in the rendered SVG", async () => {
      mockExecOnce({
        source_path: "/project1/geo1/box",
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
      // Bypass the schema by calling Impl directly with a hostile value — this
      // exercises escapeXmlAttr regardless of validator strictness.
      const result = await exportSopToSvgImpl(makeCtx(), {
        source_path: "/project1/geo1/box",
        stroke_color: 'red"><script>x</script>',
        stroke_width: 1,
        fill_color: 'none"><img>',
        scale: 100,
        flip_y: true,
      });
      expect(result.isError).toBeFalsy();
      const r = jsonOf(result);
      const svg = r.svg as string;
      // The raw attack string must not appear verbatim inside the SVG.
      expect(svg).not.toContain('red"><script>');
      expect(svg).not.toContain('none"><img>');
      // Entity-encoded forms should be present instead.
      expect(svg).toContain("&quot;");
      expect(svg).toContain("&lt;");
      expect(svg).toContain("&gt;");
    });
  });
});
