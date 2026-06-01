import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { createColorWheelsImpl } from "../../src/tools/layer1/createColorWheels.js";
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

const DEFAULTS = {
  lift: [1, 1, 1] as [number, number, number],
  gamma: [1, 1, 1] as [number, number, number],
  gain: [1, 1, 1] as [number, number, number],
  offset: 0,
  saturation: 1,
  expose_controls: false,
  parent_path: "/project1",
};

describe("create_color_wheels", () => {
  it("builds the lift→gamma→gain→master→hsv chain over a default ramp", async () => {
    const bodies = captureCreateBodies();
    const result = await createColorWheelsImpl(makeCtx(), { ...DEFAULTS });
    expect(result.isError).toBeFalsy();

    expect(bodies.find((b) => b.name === "source")?.type).toBe("rampTOP");
    expect(bodies.find((b) => b.name === "lift_wheel")?.type).toBe("levelTOP");
    expect(bodies.find((b) => b.name === "gamma_wheel")?.type).toBe("levelTOP");
    expect(bodies.find((b) => b.name === "gain_wheel")?.type).toBe("levelTOP");
    expect(bodies.find((b) => b.name === "master_level")?.type).toBe("levelTOP");
    expect(bodies.find((b) => b.name === "saturation")?.type).toBe("hsvadjustTOP");
    expect(bodies.find((b) => b.name === "out1")?.type).toBe("nullTOP");
  });

  it("maps lift/gamma/gain to redmult1/greenmult1/bluemult1 with stage bias", async () => {
    const bodies = captureCreateBodies();
    await createColorWheelsImpl(makeCtx(), {
      ...DEFAULTS,
      lift: [1.2, 1, 0.9],
      gamma: [1, 0.8, 1],
      gain: [1, 1.1, 1.4],
      offset: 0.1,
      saturation: 1.5,
    });
    const lift = bodies.find((b) => b.name === "lift_wheel");
    expect(lift?.parameters).toMatchObject({
      gamma1: 1.4,
      redmult1: 1.2,
      greenmult1: 1,
      bluemult1: 0.9,
    });
    const gain = bodies.find((b) => b.name === "gain_wheel");
    expect(gain?.parameters).toMatchObject({
      brightness1: 1.1,
      redmult1: 1,
      greenmult1: 1.1,
      bluemult1: 1.4,
    });
    expect(bodies.find((b) => b.name === "master_level")?.parameters).toMatchObject({
      blacklevel: 0.1,
    });
    expect(bodies.find((b) => b.name === "saturation")?.parameters).toMatchObject({
      saturationmult: 1.5,
    });
  });

  it("pulls an external source in via a Select TOP when source_path is given", async () => {
    const bodies = captureCreateBodies();
    await createColorWheelsImpl(makeCtx(), { ...DEFAULTS, source_path: "/scene/render" });
    const src = bodies.find((b) => b.name === "source");
    expect(src?.type).toBe("selectTOP");
    expect(src?.parameters).toMatchObject({ top: "/scene/render" });
    expect(bodies.some((b) => b.type === "rampTOP")).toBe(false);
  });

  it("exposes 11 bindable float controls (3 per wheel + offset + saturation) when expose_controls is true", async () => {
    const scripts: string[] = [];
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        scripts.push(((await request.json()) as { script: string }).script);
        return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
      }),
    );
    await createColorWheelsImpl(makeCtx(), {
      ...DEFAULTS,
      lift: [1.2, 1, 0.9],
      gamma: [1, 0.8, 1],
      gain: [1, 1.1, 1.4],
      expose_controls: true,
    });
    const panel = scripts.find((s) => s.includes("appendCustomPage"));
    expect(panel).toBeDefined();
    const b64 = /b64decode\("([^"]+)"\)/.exec(panel ?? "")?.[1];
    if (b64 === undefined) throw new Error("panel script did not embed a base64 payload");
    const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as {
      controls: Array<{
        name: string;
        bind_to?: string[];
        type: string;
        default?: unknown;
      }>;
    };
    const by = (name: string) => payload.controls.find((c) => c.name === name);

    // Three floats per wheel, each individually bound to the matching Level TOP
    // R/G/B multiplier — `rgb` swatches would be ignored by createControlPanel.
    for (const name of [
      "LiftR",
      "LiftG",
      "LiftB",
      "GammaR",
      "GammaG",
      "GammaB",
      "GainR",
      "GainG",
      "GainB",
    ]) {
      const c = by(name);
      expect(c, `missing control ${name}`).toBeDefined();
      expect(c?.type).toBe("float");
      expect(c?.bind_to?.[0]).toBeDefined();
    }
    expect(by("LiftR")?.bind_to?.[0]).toMatch(/lift_wheel\.redmult1$/);
    expect(by("LiftG")?.bind_to?.[0]).toMatch(/lift_wheel\.greenmult1$/);
    expect(by("LiftB")?.bind_to?.[0]).toMatch(/lift_wheel\.bluemult1$/);
    expect(by("GammaR")?.bind_to?.[0]).toMatch(/gamma_wheel\.redmult1$/);
    expect(by("GammaG")?.bind_to?.[0]).toMatch(/gamma_wheel\.greenmult1$/);
    expect(by("GammaB")?.bind_to?.[0]).toMatch(/gamma_wheel\.bluemult1$/);
    expect(by("GainR")?.bind_to?.[0]).toMatch(/gain_wheel\.redmult1$/);
    expect(by("GainG")?.bind_to?.[0]).toMatch(/gain_wheel\.greenmult1$/);
    expect(by("GainB")?.bind_to?.[0]).toMatch(/gain_wheel\.bluemult1$/);
    // Per-channel defaults should match the user-supplied RGB triples.
    expect(by("LiftR")?.default).toBe(1.2);
    expect(by("GammaG")?.default).toBe(0.8);
    expect(by("GainB")?.default).toBe(1.4);

    expect(by("Offset")?.bind_to?.[0]).toMatch(/master_level\.blacklevel$/);
    expect(by("Saturation")?.bind_to?.[0]).toMatch(/saturation\.saturationmult$/);
    expect(payload.controls).toHaveLength(11);
  });
});
