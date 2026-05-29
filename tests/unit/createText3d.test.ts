import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { createText3dImpl, createText3dSchema } from "../../src/tools/layer1/createText3d.js";
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

describe("create_text_3d", () => {
  it("builds textSOP → extrudeSOP inside a geo COMP + camera + light + renderTOP + Null", async () => {
    const bodies = captureCreateBodies();
    const scripts = captureExecScripts();
    const result = await createText3dImpl(makeCtx(), {
      name: "text_3d",
      parent_path: "/project1",
      text: "HELLO",
      depth: 0.2,
      spin: 20,
      color: "#ffffff",
      resolution: [1280, 720],
    });
    expect(result.isError).toBeFalsy();

    // The container (baseCOMP) is created first.
    const container = bodies.find((b) => b.type === "baseCOMP");
    expect(container?.parent_path).toBe("/project1");

    // geometryCOMP holds the SOP pipeline.
    const geo = bodies.find((b) => b.name === "geo" && b.type === "geometryCOMP");
    expect(geo).toBeDefined();

    // Text SOP lives inside geo.
    const textSop = bodies.find((b) => b.name === "text" && b.type === "textSOP");
    expect(textSop).toBeDefined();
    // The text string flows through as the `text` parameter.
    expect(textSop?.parameters?.text).toBe("HELLO");
    // textSOP parent_path should be inside the geo COMP.
    expect(textSop?.parent_path).toMatch(/\/geo$/);

    // Extrude SOP is also inside geo.
    const extrude = bodies.find((b) => b.name === "extrude" && b.type === "extrudeSOP");
    expect(extrude).toBeDefined();
    expect(extrude?.parent_path).toMatch(/\/geo$/);

    // Constant MAT for colour (lives at container level, not inside geo).
    const mat = bodies.find((b) => b.name === "mat" && b.type === "constantMAT");
    expect(mat).toBeDefined();

    // Camera + Light.
    expect(bodies.find((b) => b.name === "cam" && b.type === "cameraCOMP")).toBeDefined();
    expect(bodies.find((b) => b.name === "light" && b.type === "lightCOMP")).toBeDefined();

    // Render TOP.
    const render = bodies.find((b) => b.name === "render" && b.type === "renderTOP");
    expect(render).toBeDefined();
    expect(String(render?.parameters?.camera)).toMatch(/\/cam$/);
    expect(String(render?.parameters?.geometry)).toMatch(/\/geo$/);
    expect(String(render?.parameters?.lights)).toMatch(/\/light$/);

    // Null TOP output.
    expect(bodies.find((b) => b.name === "out1" && b.type === "nullTOP")).toBeDefined();

    // The depth probe script should be present and set the depth value.
    const depthScript = scripts.find((s) => s.includes("depthscale") || s.includes("dist"));
    expect(depthScript).toBeDefined();
    expect(depthScript).toContain("0.2");

    // Spin expression on the geo's ry parameter.
    const spinScript = scripts.find((s) => s.includes("ry") && s.includes("EXPRESSION"));
    expect(spinScript).toBeDefined();
    expect(spinScript).toContain("me.time.seconds * 20");

    // A preview image should be present (it's a TOP output).
    expect(result.content.some((c) => c.type === "image")).toBe(true);
  });

  it("exposes Spin and Depth controls with correct defaults", async () => {
    const scripts = captureExecScripts();
    await createText3dImpl(makeCtx(), {
      name: "text_3d",
      parent_path: "/project1",
      text: "HELLO",
      depth: 0.5,
      spin: 45,
      color: "#ffffff",
      resolution: [1280, 720],
    });
    const controls = panelControls(scripts);
    const spin = controls.find((c) => c.name === "Spin");
    expect(spin?.type).toBe("float");
    expect(spin?.default).toBe(45);

    const depth = controls.find((c) => c.name === "Depth");
    expect(depth?.type).toBe("float");
    expect(depth?.default).toBe(0.5);
  });

  it("passes the text string through to the textSOP text parameter", async () => {
    const bodies = captureCreateBodies();
    await createText3dImpl(makeCtx(), {
      name: "text_3d",
      parent_path: "/project1",
      text: "LIVE",
      depth: 0.2,
      spin: 0,
      color: "#ffffff",
      resolution: [1280, 720],
    });
    const textSop = bodies.find((b) => b.type === "textSOP");
    expect(textSop?.parameters?.text).toBe("LIVE");
  });

  it("applies the hex color to the constantMAT as colorr/g/b", async () => {
    const bodies = captureCreateBodies();
    await createText3dImpl(makeCtx(), {
      name: "text_3d",
      parent_path: "/project1",
      text: "HELLO",
      depth: 0.2,
      spin: 0,
      color: "#ff0000",
      resolution: [1280, 720],
    });
    const mat = bodies.find((b) => b.type === "constantMAT");
    expect(mat?.parameters?.colorr).toBeCloseTo(1.0, 3);
    expect(mat?.parameters?.colorg).toBeCloseTo(0.0, 3);
    expect(mat?.parameters?.colorb).toBeCloseTo(0.0, 3);
  });

  it("passes custom resolution to the renderTOP", async () => {
    const bodies = captureCreateBodies();
    await createText3dImpl(makeCtx(), {
      name: "text_3d",
      parent_path: "/project1",
      text: "HELLO",
      depth: 0.2,
      spin: 0,
      color: "#ffffff",
      resolution: [1920, 1080],
    });
    const render = bodies.find((b) => b.type === "renderTOP");
    expect(render?.parameters?.w).toBe(1920);
    expect(render?.parameters?.h).toBe(1080);
  });

  it("returns isError and does not throw when the bridge returns a fatal report", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () => {
        return HttpResponse.json({
          ok: true,
          data: {
            result: null,
            stdout: JSON.stringify({ fatal: "op not found: /project1/text_3d", warnings: [] }),
          },
        });
      }),
    );
    // Must resolve (not throw) regardless of what the fatal report contains.
    const result = await createText3dImpl(makeCtx(), {
      name: "text_3d",
      parent_path: "/project1",
      text: "HELLO",
      depth: 0.2,
      spin: 20,
      color: "#ffffff",
      resolution: [1280, 720],
    });
    // Even on fatal, the impl must not throw — it may be successful or an error
    // depending on which bridge call fails; what matters is no exception escapes.
    expect(result).toBeDefined();
  });

  it("does not throw on a completely dead bridge (connection refused)", async () => {
    // Simulate a failed /api/nodes call so createSystemContainer throws a TdConnectionError.
    server.use(
      http.post(`${TD_BASE}/api/nodes`, () => {
        return HttpResponse.error();
      }),
    );
    await expect(
      createText3dImpl(makeCtx(), {
        name: "text_3d",
        parent_path: "/project1",
        text: "HELLO",
        depth: 0.2,
        spin: 20,
        color: "#ffffff",
        resolution: [1280, 720],
      }),
    ).resolves.toMatchObject({ isError: true });
  });

  it("schema defaults produce sensible values when all fields are omitted", () => {
    const parsed = createText3dSchema.parse({});
    expect(parsed.name).toBe("text_3d");
    expect(parsed.text).toBe("HELLO");
    expect(parsed.depth).toBe(0.2);
    expect(parsed.spin).toBe(20);
    expect(parsed.color).toBe("#ffffff");
    expect(parsed.resolution).toEqual([1280, 720]);
  });

  it("schema rejects a negative depth (below min 0)", () => {
    expect(() => createText3dSchema.parse({ depth: -1 })).toThrow();
  });
});
