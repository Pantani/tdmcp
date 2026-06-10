import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { createStipplePointcloudImpl } from "../../src/tools/layer1/createStipplePointcloud.js";
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

// Returns the list of created node bodies AND captures the python exec scripts
// so tests can assert on both the topology and the param wiring.
function captureAll(): { bodies: CreatedNodeBody[]; scripts: string[] } {
  const bodies: CreatedNodeBody[] = [];
  const scripts: string[] = [];
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
    http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
      const body = (await request.json()) as { script: string };
      scripts.push(body.script);
      return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
    }),
  );
  return { bodies, scripts };
}

const DEFAULTS = {
  parent_path: "/project1",
  name: "stipple_pointcloud",
  dot_size: 2,
  density: 20000,
  mode: "bw_dots" as const,
  color_mode: "white_on_black" as const,
  palette_color: [0.95, 0.9, 0.7] as [number, number, number],
  jitter_amount: 0.25,
  resolution: [1280, 720] as [number, number],
  expose_controls: false,
};

describe("create_stipple_pointcloud", () => {
  // Case 1: bw_dots defaults — rampTOP source, particlePOP, one lookupTexturePOP, nullPOP, geo, nullTOP.
  it("bw_dots defaults — builds ramp source, emitter, density lut, null pop, geo rig, out1", async () => {
    const { bodies, scripts } = captureAll();
    const result = await createStipplePointcloudImpl(makeCtx(), { ...DEFAULTS });
    expect(result.isError).toBeFalsy();

    // Source is a rampTOP (no source_top_path given).
    expect(bodies.find((b) => b.name === "source")?.type).toBe("rampTOP");
    // Emitter.
    const emitter = bodies.find((b) => b.name === "emit");
    expect(emitter?.type).toBe("particlePOP");
    expect(emitter?.parameters).toMatchObject({ maxparticles: 20000, birthrate: 20000 });
    // Density lookup.
    expect(bodies.find((b) => b.name === "density_lut")?.type).toBe("lookuptexturePOP");
    // par.top set via python for the lookup.
    expect(scripts.some((s) => s.includes("density_lut") && s.includes(".par.top"))).toBe(true);
    // No jitter or colour lut in bw_dots mode.
    expect(bodies.some((b) => b.name === "jitter")).toBe(false);
    expect(bodies.some((b) => b.name === "color_lut")).toBe(false);
    // Null POP and render rig.
    expect(bodies.find((b) => b.name === "out_pop")?.type).toBe("nullPOP");
    expect(bodies.find((b) => b.name === "geo")?.type).toBe("geometryCOMP");
    expect(bodies.find((b) => b.name === "mat")?.type).toBe("constantMAT");
    expect(bodies.find((b) => b.name === "cam")?.type).toBe("cameraCOMP");
    expect(bodies.find((b) => b.name === "light")?.type).toBe("lightCOMP");
    expect(bodies.find((b) => b.name === "render")?.type).toBe("renderTOP");
    expect(bodies.find((b) => b.name === "out1")?.type).toBe("nullTOP");
    // geometryCOMP instancepop wired via python (real TD 099 par name).
    expect(scripts.some((s) => s.includes("instancepop"))).toBe(true);
    // expose_controls=false → no control panel script.
    expect(scripts.some((s) => s.includes("appendCustomPage"))).toBe(false);
  });

  // Case 2: colored_dots with provided source — selectTOP, two lookupTexturePOPs, Cd attr.
  it("colored_dots with source_top_path — selectTOP + two lookupTexturePOPs with par.top set", async () => {
    const { bodies, scripts } = captureAll();
    const result = await createStipplePointcloudImpl(makeCtx(), {
      ...DEFAULTS,
      source_top_path: "/project1/moviefilein1",
      mode: "colored_dots",
    });
    expect(result.isError).toBeFalsy();

    // selectTOP wraps external source.
    const src = bodies.find((b) => b.name === "source");
    expect(src?.type).toBe("selectTOP");
    expect(src?.parameters).toMatchObject({ top: "/project1/moviefilein1" });

    // Two lookupTexturePOPs.
    const luts = bodies.filter((b) => b.type === "lookuptexturePOP");
    expect(luts.length).toBe(2);

    // color_lut has outputattr=Cd.
    const colorLut = bodies.find((b) => b.name === "color_lut");
    expect(colorLut?.type).toBe("lookuptexturePOP");
    expect(colorLut?.parameters).toMatchObject({ outputattr: "Cd" });

    // Both lookups get par.top via python.
    const topScripts = scripts.filter((s) => s.includes(".par.top"));
    expect(topScripts.length).toBeGreaterThanOrEqual(2);

    // Result extra has color_lut_path — extract JSON block from the text.
    if (!result.isError) {
      const content = result.content[0];
      if (content?.type === "text") {
        const jsonBlock = content.text.match(/```json\n([\s\S]+?)\n```/)?.[1];
        if (jsonBlock !== undefined) {
          const parsed = JSON.parse(jsonBlock) as { color_lut_path?: unknown };
          expect(parsed.color_lut_path).toBeDefined();
        }
      }
    }
  });

  // Case 3: random_jitter mode — noisePOP present, jitter_path in extra, JitterAmount control exposed.
  it("random_jitter mode — adds noisePOP jitter, exposes JitterAmount control", async () => {
    const { bodies, scripts } = captureAll();
    const result = await createStipplePointcloudImpl(makeCtx(), {
      ...DEFAULTS,
      mode: "random_jitter",
      jitter_amount: 0.4,
      expose_controls: true,
    });
    expect(result.isError).toBeFalsy();

    // noisePOP jitter is in the chain.
    const jitter = bodies.find((b) => b.name === "jitter");
    expect(jitter?.type).toBe("noisePOP");
    expect(jitter?.parameters).toMatchObject({ amp: 0.4 });

    // No color_lut in random_jitter.
    expect(bodies.some((b) => b.name === "color_lut")).toBe(false);

    // extra.jitter_path present.
    if (!result.isError) {
      const content = result.content[0];
      if (content?.type === "text") {
        const jsonBlock = content.text.match(/```json\n([\s\S]+?)\n```/)?.[1];
        if (jsonBlock !== undefined) {
          const parsed = JSON.parse(jsonBlock) as { jitter_path?: unknown };
          expect(parsed.jitter_path).toBeDefined();
        }
      }
    }

    // Control panel includes JitterAmount.
    const panel = scripts.find((s) => s.includes("appendCustomPage"));
    expect(panel).toBeDefined();
    const b64 = /b64decode\("([^"]+)"\)/.exec(panel ?? "")?.[1];
    if (b64 === undefined) throw new Error("panel script missing base64 payload");
    const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as {
      controls: Array<{ name: string }>;
    };
    const names = payload.controls.map((c) => c.name);
    expect(names).toContain("JitterAmount");
    expect(names).toContain("DotSize");
    expect(names).toContain("CameraRotate");
  });

  // Case 4: high density clamp — schema rejects >200000; density=50000 builds fine.
  it("rejects density > 200000 via Zod, and density=50000 builds without isError", async () => {
    captureAll();
    // Zod parse must reject.
    const parsed = createStipplePointcloudSchema.safeParse({ density: 999999 });
    expect(parsed.success).toBe(false);

    // 50000 must succeed.
    const { createStipplePointcloudSchema: schema2 } = await import(
      "../../src/tools/layer1/createStipplePointcloud.js"
    );
    const ok = schema2.safeParse({ density: 50000 });
    expect(ok.success).toBe(true);

    const result = await createStipplePointcloudImpl(makeCtx(), { ...DEFAULTS, density: 50000 });
    expect(result.isError).toBeFalsy();
  });

  // Case 5: expose_controls=false — controls array empty, no control panel script.
  it("expose_controls=false — no control panel created, controls array empty", async () => {
    const { scripts } = captureAll();
    const result = await createStipplePointcloudImpl(makeCtx(), {
      ...DEFAULTS,
      expose_controls: false,
    });
    expect(result.isError).toBeFalsy();
    expect(scripts.some((s) => s.includes("appendCustomPage"))).toBe(false);

    if (!result.isError) {
      const content = result.content[0];
      if (content?.type === "text") {
        const jsonBlock = content.text.match(/```json\n([\s\S]+?)\n```/)?.[1];
        if (jsonBlock !== undefined) {
          const parsed = JSON.parse(jsonBlock) as { controls?: unknown[] };
          if (parsed.controls !== undefined) {
            expect(parsed.controls.length).toBe(0);
          }
        }
      }
    }
  });

  // Case 6: color_mode=palette with custom palette_color — constantMAT coloured accordingly.
  it("color_mode=palette with custom palette_color — constantMAT gets palette RGB", async () => {
    const { bodies } = captureAll();
    const result = await createStipplePointcloudImpl(makeCtx(), {
      ...DEFAULTS,
      mode: "bw_dots",
      color_mode: "palette",
      palette_color: [0.2, 0.8, 0.5],
    });
    expect(result.isError).toBeFalsy();

    const mat = bodies.find((b) => b.name === "mat");
    expect(mat?.type).toBe("constantMAT");
    expect(mat?.parameters).toMatchObject({
      colorr: 0.2,
      colorg: 0.8,
      colorb: 0.5,
    });
  });
});

// Re-export schema for inline test usage
import { createStipplePointcloudSchema } from "../../src/tools/layer1/createStipplePointcloud.js";
