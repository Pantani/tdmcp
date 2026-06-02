import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { z } from "zod";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  createStrangeAttractorImpl,
  createStrangeAttractorSchema,
} from "../../src/tools/layer1/createStrangeAttractor.js";
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

function captureExecScripts(): string[] {
  const scripts: string[] = [];
  server.use(
    http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
      scripts.push(((await request.json()) as { script: string }).script);
      return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
    }),
  );
  return scripts;
}

function panelControls(
  scripts: string[],
): Array<{ name: string; type?: string; bind_to?: string[] }> {
  const panel = scripts.find((s) => s.includes("appendCustomPage"));
  const b64 = /b64decode\("([^"]+)"\)/.exec(panel ?? "")?.[1];
  if (b64 === undefined) return [];
  return (
    JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as {
      controls: Array<{ name: string; type?: string; bind_to?: string[] }>;
    }
  ).controls;
}

/** Extract the config JSON written to the config DAT. */
function findConfigPayload(
  scripts: string[],
): { attractor: string; params: Record<string, number>; trail_length: number } | undefined {
  const setter = scripts.find(
    (s) => /op\("[^"]*\/config"\)\.text = /.test(s) || /op\("config"\)\.text = /.test(s),
  );
  if (!setter) return undefined;
  const m = /\.text = (".*?")\n?$/s.exec(setter);
  if (!m?.[1]) return undefined;
  const inner = JSON.parse(m[1]) as string;
  return JSON.parse(inner) as {
    attractor: string;
    params: Record<string, number>;
    trail_length: number;
  };
}

function run(args: Partial<z.input<typeof createStrangeAttractorSchema>> = {}) {
  return createStrangeAttractorImpl(makeCtx(), createStrangeAttractorSchema.parse(args));
}

describe("create_strange_attractor", () => {
  it("default Lorenz build creates all required operators and ends at /out1", async () => {
    const bodies = captureCreateBodies();
    const result = await run();
    expect(result.isError).toBeFalsy();

    const types = new Set(bodies.map((b) => `${b.name}:${b.type}`));
    // baseCOMP created via createSystemContainer
    expect(types).toContain("config:textDAT");
    expect(types).toContain("integrate:scriptCHOP");
    expect(types).toContain("integrate_cb:textDAT");
    expect(types).toContain("trail:scriptSOP");
    expect(types).toContain("trail_cb:textDAT");
    expect(types).toContain("thicken:tubeSOP");
    expect(types).toContain("bounds:boundSOP");
    expect(types).toContain("geo:geometryCOMP");
    expect(types).toContain("in1:selectSOP");
    expect(types).toContain("mat:constantMAT");
    expect(types).toContain("cam:cameraCOMP");
    expect(types).toContain("light:lightCOMP");
    expect(types).toContain("render:renderTOP");
    expect(types).toContain("out1:nullTOP");

    expect(textOf(result)).toContain("/out1");
  });

  it("config DAT contains attractor=lorenz and default Lorenz params (sigma=10, rho=28)", async () => {
    const scripts = captureExecScripts();
    await run();
    const cfg = findConfigPayload(scripts);
    expect(cfg).toBeDefined();
    expect(cfg?.attractor).toBe("lorenz");
    expect(cfg?.params.sigma).toBe(10);
    expect(cfg?.params.rho).toBe(28);
  });

  it("Aizawa with params override merges defaults keeping non-overridden keys", async () => {
    const scripts = captureExecScripts();
    await run({ attractor: "aizawa", params: { a: 1.2 } });
    const cfg = findConfigPayload(scripts);
    expect(cfg?.attractor).toBe("aizawa");
    // Overridden a
    expect(cfg?.params.a).toBe(1.2);
    // Non-overridden Aizawa defaults retained
    expect(cfg?.params.b).toBeCloseTo(0.7);
    expect(cfg?.params.c).toBeCloseTo(0.6);
  });

  it("thickness=0 skips tubeSOP and selectSOP sop param points at trail", async () => {
    const bodies = captureCreateBodies();
    await run({ thickness: 0 });
    const names = new Set(bodies.map((b) => b.name));
    expect(names.has("thicken")).toBe(false);
    // selectSOP should have sop pointing at trail (path or name)
    const select = bodies.find((b) => b.name === "in1");
    const sop = select?.parameters?.sop as string | undefined;
    expect(sop).toBeDefined();
    expect(sop?.endsWith("trail") || sop === "trail").toBe(true);
  });

  it("expose_controls=false produces empty controls array", async () => {
    const scripts = captureExecScripts();
    await run({ expose_controls: false });
    expect(panelControls(scripts)).toEqual([]);
  });

  it("expose_controls=true produces 4 controls with correct names", async () => {
    const scripts = captureExecScripts();
    await run({ expose_controls: true, thickness: 0.015 });
    const names = panelControls(scripts).map((c) => c.name);
    expect(names).toContain("StepsPerFrame");
    expect(names).toContain("Dt");
    expect(names).toContain("TrailLength");
    expect(names).toContain("Thickness");
  });

  it("Thickness control bind_to includes thicken.rad1 and thicken.rad2", async () => {
    const scripts = captureExecScripts();
    await run({ expose_controls: true, thickness: 0.015 });
    const controls = panelControls(scripts);
    const thicknessCtrl = controls.find((c) => c.name === "Thickness");
    expect(thicknessCtrl).toBeDefined();
    const bindTo = thicknessCtrl?.bind_to ?? [];
    expect(bindTo.some((b) => b.includes("thicken") && b.includes("rad1"))).toBe(true);
    expect(bindTo.some((b) => b.includes("thicken") && b.includes("rad2"))).toBe(true);
  });

  it("auto_frame=false sets cam.tz to fixed fallback 30", async () => {
    const bodies = captureCreateBodies();
    await run({ auto_frame: false });
    const cam = bodies.find((b) => b.name === "cam");
    expect(cam?.parameters?.tz).toBe(30);
  });

  it("auto_frame=true for lorenz sets cam.tz = 30*3 = 90", async () => {
    const bodies = captureCreateBodies();
    await run({ attractor: "lorenz", auto_frame: true });
    const cam = bodies.find((b) => b.name === "cam");
    expect(cam?.parameters?.tz).toBe(90);
  });

  it("auto_frame=true for aizawa sets cam.tz = 2*3 = 6", async () => {
    const bodies = captureCreateBodies();
    await run({ attractor: "aizawa", auto_frame: true });
    const cam = bodies.find((b) => b.name === "cam");
    expect(cam?.parameters?.tz).toBe(6);
  });

  it("invalid attractor enum is rejected by schema", () => {
    expect(() => createStrangeAttractorSchema.parse({ attractor: "rossler" })).toThrow();
  });

  it("docks integrate_cb callback onto Script CHOP", async () => {
    const scripts = captureExecScripts();
    await run();
    expect(
      scripts.some((s) => s.includes("par.callbacks") && s.includes("def cook(scriptOp)")),
    ).toBe(true);
  });

  it("trail_cb references op('integrate') to read channels", async () => {
    const scripts = captureExecScripts();
    await run();
    expect(
      scripts.some((s) => s.includes("op('integrate')") || s.includes('op("integrate")')),
    ).toBe(true);
  });

  it("render TOP references cam and geo", async () => {
    const bodies = captureCreateBodies();
    await run();
    const render = bodies.find((b) => b.name === "render");
    expect(render?.parameters?.camera).toBeDefined();
    expect(render?.parameters?.geometry).toBeDefined();
    expect(render?.parameters?.lights).toBeDefined();
  });

  it("returns a friendly isError result when bridge create fails (no throw)", async () => {
    server.use(
      http.post(`${TD_BASE}/api/nodes`, () =>
        HttpResponse.json({ ok: false, error: { code: "boom", message: "nope" } }, { status: 500 }),
      ),
    );
    const result = await run();
    expect(result.isError).toBe(true);
  });
});
