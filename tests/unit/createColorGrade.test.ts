import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { createColorGradeImpl } from "../../src/tools/layer1/createColorGrade.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

interface CreatedNodeBody {
  parent_path: string;
  type: string;
  name?: string;
  parameters?: Record<string, unknown>;
}

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

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

/** Records every POST /api/nodes body so a test can assert what was created + with which params. */
function captureCreateBodies(): CreatedNodeBody[] {
  const bodies: CreatedNodeBody[] = [];
  server.use(
    http.post(`${TD_BASE}/api/nodes`, async ({ request }) => {
      const body = (await request.json()) as CreatedNodeBody;
      bodies.push(body);
      const name = body.name ?? `${body.type.replace(/[^a-zA-Z0-9]/g, "").toLowerCase()}1`;
      return HttpResponse.json({
        ok: true,
        data: { path: `${body.parent_path}/${name}`, type: body.type, name },
      });
    }),
  );
  return bodies;
}

describe("create_color_grade", () => {
  it("builds a grade chain over a default ramp test source (no input)", async () => {
    const bodies = captureCreateBodies();
    const result = await createColorGradeImpl(makeCtx(), {
      brightness: 1,
      gamma: 1,
      contrast: 1,
      black_level: 0,
      saturation: 1,
      hue: 0,
      expose_controls: false,
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("/project1/color_grade");
    expect(text).toContain("/project1/color_grade/out1");

    // With no input_path the source is a Ramp TOP, then Level → HSV Adjust → Null.
    expect(bodies.find((b) => b.name === "source")?.type).toBe("rampTOP");
    expect(bodies.find((b) => b.name === "grade_level")?.type).toBe("levelTOP");
    expect(bodies.find((b) => b.name === "grade_hsv")?.type).toBe("hsvadjustTOP");
    expect(bodies.find((b) => b.name === "out1")?.type).toBe("nullTOP");
    // No LUT requested → no Lookup / Movie File In TOP.
    expect(bodies.some((b) => b.type === "lookupTOP")).toBe(false);
    expect(bodies.some((b) => b.type === "moviefileinTOP")).toBe(false);
  });

  it("maps brightness/gamma/contrast to the Level TOP's brightness1/gamma1/contrast tokens", async () => {
    const bodies = captureCreateBodies();
    await createColorGradeImpl(makeCtx(), {
      brightness: 1.5,
      gamma: 0.8,
      contrast: 1.2,
      black_level: 0.05,
      saturation: 2,
      hue: 90,
      expose_controls: false,
      parent_path: "/project1",
    });
    const level = bodies.find((b) => b.name === "grade_level");
    expect(level?.type).toBe("levelTOP");
    // brightness1 is the gain control (NOT `gain`); confirm the exact param tokens.
    expect(level?.parameters).toMatchObject({
      brightness1: 1.5,
      gamma1: 0.8,
      contrast: 1.2,
      blacklevel: 0.05,
    });
    expect(level?.parameters).not.toHaveProperty("gain");

    const hsv = bodies.find((b) => b.name === "grade_hsv");
    expect(hsv?.type).toBe("hsvadjustTOP");
    expect(hsv?.parameters).toMatchObject({ saturationmult: 2, hueoffset: 90 });
  });

  it("pulls an external source in via a Select TOP (path reference, not a wire)", async () => {
    const bodies = captureCreateBodies();
    const result = await createColorGradeImpl(makeCtx(), {
      brightness: 1,
      gamma: 1,
      contrast: 1,
      black_level: 0,
      saturation: 1,
      hue: 0,
      input_path: "/scene/render",
      expose_controls: false,
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();
    const source = bodies.find((b) => b.name === "source");
    expect(source?.type).toBe("selectTOP");
    expect(source?.parameters).toMatchObject({ top: "/scene/render" });
    // The external source must NOT be brought in as a ramp when a path is supplied.
    expect(bodies.some((b) => b.type === "rampTOP")).toBe(false);
  });

  it("wires a LUT file into the Lookup TOP's second input when lut_path is given", async () => {
    const bodies = captureCreateBodies();
    const result = await createColorGradeImpl(makeCtx(), {
      brightness: 1,
      gamma: 1,
      contrast: 1,
      black_level: 0,
      saturation: 1,
      hue: 0,
      lut_path: "/luts/teal_orange.png",
      expose_controls: false,
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();
    const lut = bodies.find((b) => b.name === "lut_file");
    expect(lut?.type).toBe("moviefileinTOP");
    expect(lut?.parameters).toMatchObject({ file: "/luts/teal_orange.png" });
    expect(bodies.find((b) => b.name === "grade_lookup")?.type).toBe("lookupTOP");

    const text = textOf(result);
    expect(text).toContain("/project1/color_grade/out1");
    expect(text).toContain("/luts/teal_orange.png");
  });

  it("exposes Brightness/Gamma/Contrast/Saturation/Hue knobs bound to the right params", async () => {
    const scripts: string[] = [];
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        scripts.push(((await request.json()) as { script: string }).script);
        return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
      }),
    );
    await createColorGradeImpl(makeCtx(), {
      brightness: 1,
      gamma: 1,
      contrast: 1,
      black_level: 0,
      saturation: 1,
      hue: 0,
      expose_controls: true,
      parent_path: "/project1",
    });
    const panel = scripts.find((s) => s.includes("appendCustomPage"));
    expect(panel).toBeDefined();
    const b64 = /b64decode\("([^"]+)"\)/.exec(panel ?? "")?.[1];
    if (b64 === undefined) throw new Error("panel script did not embed a base64 payload");
    const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as {
      controls: Array<{ name: string; bind_to?: string[] }>;
    };
    const by = (name: string) => payload.controls.find((c) => c.name === name);
    expect(by("Brightness")?.bind_to?.[0]).toMatch(/grade_level\.brightness1$/);
    expect(by("Gamma")?.bind_to?.[0]).toMatch(/grade_level\.gamma1$/);
    expect(by("Contrast")?.bind_to?.[0]).toMatch(/grade_level\.contrast$/);
    expect(by("Saturation")?.bind_to?.[0]).toMatch(/grade_hsv\.saturationmult$/);
    expect(by("Hue")?.bind_to?.[0]).toMatch(/grade_hsv\.hueoffset$/);
  });
});
