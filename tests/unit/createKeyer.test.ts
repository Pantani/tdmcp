import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { createKeyerImpl, createKeyerSchema } from "../../src/tools/layer1/createKeyer.js";
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

describe("create_keyer", () => {
  // --------------------------------------------------------------------------
  // chroma mode — the primary / default path
  // --------------------------------------------------------------------------

  it("chroma mode: creates a Chroma Key TOP + Composite TOP + Null out1", async () => {
    const bodies = captureCreateBodies();
    captureExecScripts();

    const result = await createKeyerImpl(makeCtx(), {
      name: "keyer",
      parent_path: "/project1",
      source: undefined,
      background: undefined,
      key_type: "chroma",
      key_color: "#00ff00",
      tolerance: 0.3,
      softness: 0.1,
      resolution: [1280, 720],
    });

    expect(result.isError).toBeFalsy();

    // A test source is created when no source is given.
    expect(bodies.some((b) => b.type === "constantTOP")).toBe(true);
    // A test background ramp.
    expect(bodies.some((b) => b.type === "rampTOP")).toBe(true);
    // The chroma key stage.
    expect(bodies.some((b) => b.type === "chromakeyTOP" && b.name === "key_chroma")).toBe(true);
    // The composite over.
    expect(bodies.some((b) => b.type === "compositeTOP" && b.name === "comp")).toBe(true);
    // Terminal null.
    expect(bodies.some((b) => b.type === "nullTOP" && b.name === "out1")).toBe(true);

    // The text summary mentions chroma.
    const text = result.content.find((c) => c.type === "text") as { text: string } | undefined;
    expect(text?.text).toContain("chroma");
  });

  it("chroma mode: exposes Tolerance, Softness, KeyColor controls", async () => {
    captureCreateBodies();
    const scripts = captureExecScripts();

    await createKeyerImpl(makeCtx(), {
      name: "keyer",
      parent_path: "/project1",
      source: undefined,
      background: undefined,
      key_type: "chroma",
      key_color: "#00ff00",
      tolerance: 0.3,
      softness: 0.1,
      resolution: [1280, 720],
    });

    const controls = panelControls(scripts);
    expect(controls.find((c) => c.name === "Tolerance")?.type).toBe("float");
    expect(controls.find((c) => c.name === "Softness")?.type).toBe("float");
    const kc = controls.find((c) => c.name === "KeyColor");
    expect(kc).toBeDefined();
    expect(kc?.type).toBe("rgb");
  });

  it("chroma mode: passes operand='over' to the Composite TOP", async () => {
    const bodies = captureCreateBodies();
    captureExecScripts();

    await createKeyerImpl(makeCtx(), {
      name: "keyer",
      parent_path: "/project1",
      source: undefined,
      background: undefined,
      key_type: "chroma",
      key_color: "#00ff00",
      tolerance: 0.3,
      softness: 0.1,
      resolution: [1280, 720],
    });

    const comp = bodies.find((b) => b.type === "compositeTOP");
    expect(comp?.parameters?.operand).toBe("over");
  });

  it("chroma mode: uses Select TOP when source is given", async () => {
    const bodies = captureCreateBodies();
    captureExecScripts();

    await createKeyerImpl(makeCtx(), {
      name: "keyer",
      parent_path: "/project1",
      source: "/project1/camera1",
      background: undefined,
      key_type: "chroma",
      key_color: "#00ff00",
      tolerance: 0.3,
      softness: 0.1,
      resolution: [1280, 720],
    });

    const sel = bodies.find((b) => b.type === "selectTOP" && b.name === "source");
    expect(sel).toBeDefined();
    expect(sel?.parameters?.top).toBe("/project1/camera1");
    // No default test card.
    expect(bodies.some((b) => b.type === "constantTOP")).toBe(false);
  });

  it("chroma mode: uses Select TOP for background when given", async () => {
    const bodies = captureCreateBodies();
    captureExecScripts();

    await createKeyerImpl(makeCtx(), {
      name: "keyer",
      parent_path: "/project1",
      source: undefined,
      background: "/project1/visuals",
      key_type: "chroma",
      key_color: "#0000ff",
      tolerance: 0.25,
      softness: 0.05,
      resolution: [1920, 1080],
    });

    const bgSel = bodies.find((b) => b.type === "selectTOP" && b.name === "bg");
    expect(bgSel).toBeDefined();
    expect(bgSel?.parameters?.top).toBe("/project1/visuals");
    // No default test background.
    expect(bodies.some((b) => b.type === "rampTOP")).toBe(false);
  });

  // --------------------------------------------------------------------------
  // rgb mode
  // --------------------------------------------------------------------------

  it("rgb mode: creates an RGB Key TOP + Composite TOP + Null", async () => {
    const bodies = captureCreateBodies();
    captureExecScripts();

    const result = await createKeyerImpl(makeCtx(), {
      name: "keyer",
      parent_path: "/project1",
      source: undefined,
      background: undefined,
      key_type: "rgb",
      key_color: "#ff0000",
      tolerance: 0.2,
      softness: 0.05,
      resolution: [1280, 720],
    });

    expect(result.isError).toBeFalsy();
    expect(bodies.some((b) => b.type === "rgbkeyTOP" && b.name === "key_rgb")).toBe(true);
    expect(bodies.some((b) => b.type === "compositeTOP" && b.name === "comp")).toBe(true);
    expect(bodies.some((b) => b.type === "nullTOP" && b.name === "out1")).toBe(true);

    const text = result.content.find((c) => c.type === "text") as { text: string } | undefined;
    expect(text?.text).toContain("rgb");
  });

  it("rgb mode: exposes Tolerance, Softness, KeyColor controls", async () => {
    captureCreateBodies();
    const scripts = captureExecScripts();

    await createKeyerImpl(makeCtx(), {
      name: "keyer",
      parent_path: "/project1",
      source: undefined,
      background: undefined,
      key_type: "rgb",
      key_color: "#ff0000",
      tolerance: 0.2,
      softness: 0.05,
      resolution: [1280, 720],
    });

    const controls = panelControls(scripts);
    expect(controls.find((c) => c.name === "Tolerance")).toBeDefined();
    expect(controls.find((c) => c.name === "Softness")).toBeDefined();
    expect(controls.find((c) => c.name === "KeyColor")?.type).toBe("rgb");
  });

  // --------------------------------------------------------------------------
  // luma mode
  // --------------------------------------------------------------------------

  it("luma mode: creates a Level TOP (key_luma) + Matte TOP (comp) + Null", async () => {
    const bodies = captureCreateBodies();
    captureExecScripts();

    const result = await createKeyerImpl(makeCtx(), {
      name: "keyer",
      parent_path: "/project1",
      source: undefined,
      background: undefined,
      key_type: "luma",
      key_color: "#00ff00",
      tolerance: 0.3,
      softness: 0.1,
      resolution: [1280, 720],
    });

    expect(result.isError).toBeFalsy();
    expect(bodies.some((b) => b.type === "levelTOP" && b.name === "key_luma")).toBe(true);
    // Matte TOP is used as the composite node in luma mode.
    expect(bodies.some((b) => b.type === "matteTOP")).toBe(true);
    expect(bodies.some((b) => b.type === "nullTOP" && b.name === "out1")).toBe(true);

    const text = result.content.find((c) => c.type === "text") as { text: string } | undefined;
    expect(text?.text).toContain("luma");
  });

  it("luma mode: exposes Tolerance and Softness controls bound to the Level TOP", async () => {
    captureCreateBodies();
    const scripts = captureExecScripts();

    await createKeyerImpl(makeCtx(), {
      name: "keyer",
      parent_path: "/project1",
      source: undefined,
      background: undefined,
      key_type: "luma",
      key_color: "#00ff00",
      tolerance: 0.3,
      softness: 0.1,
      resolution: [1280, 720],
    });

    const controls = panelControls(scripts);
    const tol = controls.find((c) => c.name === "Tolerance");
    const soft = controls.find((c) => c.name === "Softness");
    expect(tol).toBeDefined();
    expect(soft).toBeDefined();
    // Both should have bind_to referencing the level node (contrast / gamma1).
    expect(tol?.bind_to?.some((b) => b.includes("contrast"))).toBe(true);
    expect(soft?.bind_to?.some((b) => b.includes("gamma1"))).toBe(true);
  });

  // --------------------------------------------------------------------------
  // schema validation
  // --------------------------------------------------------------------------

  it("rejects an invalid key_type at the schema boundary", () => {
    expect(() => createKeyerSchema.parse({ key_type: "magic" })).toThrow();
  });

  it("rejects tolerance outside 0–1", () => {
    expect(() => createKeyerSchema.parse({ tolerance: 1.5 })).toThrow();
    expect(() => createKeyerSchema.parse({ tolerance: -0.1 })).toThrow();
  });

  it("defaults are applied correctly", () => {
    const parsed = createKeyerSchema.parse({});
    expect(parsed.name).toBe("keyer");
    expect(parsed.parent_path).toBe("/project1");
    expect(parsed.key_type).toBe("chroma");
    expect(parsed.key_color).toBe("#00ff00");
    expect(parsed.tolerance).toBe(0.3);
    expect(parsed.softness).toBe(0.1);
    expect(parsed.resolution).toEqual([1280, 720]);
  });

  // --------------------------------------------------------------------------
  // bridge fatal — no-throw guarantee
  // --------------------------------------------------------------------------

  it("returns isError and does not throw when the bridge returns a fatal", async () => {
    // Override /api/nodes to fail with a fatal connection error.
    server.use(
      http.post(`${TD_BASE}/api/nodes`, () => {
        return HttpResponse.json({ ok: false, error: "TD offline" }, { status: 503 });
      }),
      http.post(`${TD_BASE}/api/exec`, () => {
        return HttpResponse.json({ ok: false, error: "TD offline" }, { status: 503 });
      }),
    );

    // createKeyerImpl must never throw — runBuild catches TD errors and returns errorResult.
    const result = await createKeyerImpl(makeCtx(), {
      name: "keyer",
      parent_path: "/project1",
      source: undefined,
      background: undefined,
      key_type: "chroma",
      key_color: "#00ff00",
      tolerance: 0.3,
      softness: 0.1,
      resolution: [1280, 720],
    });

    // The handler must return an errorResult (not throw).
    expect(result.isError).toBe(true);
  });
});
