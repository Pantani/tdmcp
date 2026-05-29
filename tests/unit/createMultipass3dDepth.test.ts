import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  multipass3dDepthImpl,
  multipass3dDepthSchema,
} from "../../src/tools/layer1/createMultipass3dDepth.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

interface CreatedNodeBody {
  parent_path: string;
  type: string;
  name?: string;
  parameters?: Record<string, unknown>;
}

interface PanelControl {
  name: string;
  type?: string;
  default?: unknown;
  bind_to?: string[];
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

function captureExecScripts(): string[] {
  const scripts: string[] = [];
  server.use(
    http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
      const body = (await request.json()) as { script: string };
      scripts.push(body.script);
      return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
    }),
  );
  return scripts;
}

function panelControls(scripts: string[]): PanelControl[] {
  const panel = scripts.find((s) => s.includes("appendCustomPage"));
  const b64 = /b64decode\("([^"]+)"\)/.exec(panel ?? "")?.[1];
  if (b64 === undefined) return [];
  const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as {
    controls: PanelControl[];
  };
  return payload.controls;
}

const FULL = {
  name: "multipass_3d",
  parent_path: "/project1",
  geometry: "torus" as const,
  instances: 1,
  ssao: true,
  expose_depth: true,
  spin: 10,
  resolution: [1280, 720] as [number, number],
};

describe("multipass_3d_depth", () => {
  it("builds geometry + camera + light + render + ssao + depth + nulls", async () => {
    const bodies = captureCreateBodies();
    const scripts = captureExecScripts();
    const result = await multipass3dDepthImpl(makeCtx(), { ...FULL });
    expect(result.isError).toBeFalsy();

    expect(bodies.find((b) => b.name === "geo")?.type).toBe("geometryCOMP");
    expect(bodies.find((b) => b.name === "shape")?.type).toBe("torusSOP");
    expect(bodies.find((b) => b.name === "cam")?.type).toBe("cameraCOMP");
    expect(bodies.find((b) => b.name === "light")?.type).toBe("lightCOMP");
    expect(bodies.find((b) => b.name === "render")?.type).toBe("renderTOP");
    expect(bodies.find((b) => b.name === "ssao")?.type).toBe("ssaoTOP");
    expect(bodies.find((b) => b.name === "depth")?.type).toBe("depthTOP");
    // Beauty pass ends on a Null, and the depth output is a second Null.
    expect(bodies.find((b) => b.name === "out1")?.type).toBe("nullTOP");
    expect(bodies.find((b) => b.name === "depth_out")?.type).toBe("nullTOP");

    // Render TOP reads its scene from parameters (camera/geometry/lights) at the resolution.
    const renderBody = bodies.find((b) => b.name === "render");
    expect(renderBody?.parameters?.camera).toBe("/project1/multipass_3d/cam");
    expect(renderBody?.parameters?.geometry).toBe("/project1/multipass_3d/geo");
    expect(renderBody?.parameters?.resolutionw).toBe(1280);
    expect(renderBody?.parameters?.resolutionh).toBe(720);

    // SSAO is combined with the color, and the depth TOP references the named render.
    expect(scripts.some((s) => s.includes("combinewithcolor"))).toBe(true);
    expect(scripts.some((s) => s.includes("par.rendertop"))).toBe(true);
    // A single object spins via geo.ry over time.
    expect(scripts.some((s) => s.includes("par.ry.expr") && s.includes("absTime.seconds"))).toBe(
      true,
    );

    const text = result.content.find((c) => c.type === "text") as { text: string } | undefined;
    expect(text?.text).toContain("depth_out");
  });

  it("exposes Spin, Zoom, and an Ssao toggle bound to combinewithcolor", async () => {
    const scripts = captureExecScripts();
    await multipass3dDepthImpl(makeCtx(), { ...FULL, spin: 25 });
    const controls = panelControls(scripts);
    expect(controls.find((c) => c.name === "Spin")?.default).toBe(25);
    expect(controls.find((c) => c.name === "Zoom")?.type).toBe("float");
    const ssao = controls.find((c) => c.name === "Ssao");
    expect(ssao?.type).toBe("toggle");
    expect(ssao?.bind_to?.[0]).toContain("combinewithcolor");
  });

  it("ssao:false omits the SSAO pass (and its toggle); output is the render → Null", async () => {
    const bodies = captureCreateBodies();
    const scripts = captureExecScripts();
    await multipass3dDepthImpl(makeCtx(), { ...FULL, ssao: false });
    expect(bodies.some((b) => b.type === "ssaoTOP")).toBe(false);
    expect(scripts.some((s) => s.includes("combinewithcolor"))).toBe(false);
    expect(panelControls(scripts).some((c) => c.name === "Ssao")).toBe(false);
    // Still produces the beauty Null output.
    expect(bodies.some((b) => b.name === "out1" && b.type === "nullTOP")).toBe(true);
  });

  it("expose_depth:false omits the Depth TOP and depth_out Null", async () => {
    const bodies = captureCreateBodies();
    const scripts = captureExecScripts();
    await multipass3dDepthImpl(makeCtx(), { ...FULL, expose_depth: false });
    expect(bodies.some((b) => b.type === "depthTOP")).toBe(false);
    expect(bodies.some((b) => b.name === "depth_out")).toBe(false);
    expect(scripts.some((s) => s.includes("par.rendertop"))).toBe(false);
  });

  it("instances > 1 scatters a grid and spins per-instance (instancery)", async () => {
    const bodies = captureCreateBodies();
    const scripts = captureExecScripts();
    await multipass3dDepthImpl(makeCtx(), { ...FULL, instances: 64 });
    expect(bodies.some((b) => b.name === "points" && b.type === "gridSOP")).toBe(true);
    expect(scripts.some((s) => s.includes("par.instancery.expr"))).toBe(true);
  });

  it("does not throw and returns isError when the bridge reports a fatal", async () => {
    // First create call rejects so runBuild's catch turns the thrown TdError into a result.
    server.use(
      http.post(`${TD_BASE}/api/nodes`, () =>
        HttpResponse.json({ ok: false, error: "boom" }, { status: 500 }),
      ),
    );
    const call = multipass3dDepthImpl(makeCtx(), { ...FULL });
    await expect(call).resolves.toBeDefined();
    const result = await call;
    expect(result.isError).toBe(true);
  });

  it("validates the schema: defaults, range, and enum", () => {
    const parsed = multipass3dDepthSchema.parse({});
    expect(parsed.name).toBe("multipass_3d");
    expect(parsed.geometry).toBe("torus");
    expect(parsed.instances).toBe(1);
    expect(parsed.ssao).toBe(true);
    expect(parsed.expose_depth).toBe(true);
    expect(parsed.spin).toBe(10);
    expect(parsed.resolution).toEqual([1280, 720]);
    // instances is clamped to a 1..2000 int range.
    expect(() => multipass3dDepthSchema.parse({ instances: 0 })).toThrow();
    expect(() => multipass3dDepthSchema.parse({ instances: 5000 })).toThrow();
    // Unknown geometry rejected.
    expect(() => multipass3dDepthSchema.parse({ geometry: "pyramid" })).toThrow();
  });
});
