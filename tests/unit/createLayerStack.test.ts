import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  createLayerStackImpl,
  createLayerStackSchema,
} from "../../src/tools/layer1/createLayerStack.js";
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
  menu_items?: string[];
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

describe("create_layer_stack", () => {
  it("builds a 3-layer explicit stack: Select/Level per layer, Composite per layer above the base, output Null", async () => {
    const bodies = captureCreateBodies();
    captureExecScripts();
    const result = await createLayerStackImpl(makeCtx(), {
      name: "layer_stack",
      parent_path: "/project1",
      count: 4,
      resolution: [1280, 720],
      layers: [
        { source: "/project1/bg", blend: "over", opacity: 1 },
        { source: "/project1/content", blend: "add", opacity: 0.8 },
        { source: "/project1/text", blend: "screen", opacity: 0.5 },
      ],
    });
    expect(result.isError).toBeFalsy();

    // Each layer pulls its external source through a Select TOP and carries opacity on a Level.
    const selects = bodies.filter((b) => b.type === "selectTOP");
    expect(selects).toHaveLength(3);
    expect(selects.map((s) => s.name)).toEqual(["sel_1", "sel_2", "sel_3"]);
    expect(selects.map((s) => s.parameters?.top)).toEqual([
      "/project1/bg",
      "/project1/content",
      "/project1/text",
    ]);

    const levels = bodies.filter((b) => b.type === "levelTOP");
    expect(levels.map((l) => l.name)).toEqual(["lvl_1", "lvl_2", "lvl_3"]);
    expect(levels.map((l) => l.parameters?.opacity)).toEqual([1, 0.8, 0.5]);

    // Two layers sit above the base, so there are two 2-input Composite TOPs, each carrying
    // its own blend mode (mapped to a real TD operand). The base layer has no Composite.
    const comps = bodies.filter((b) => b.type === "compositeTOP");
    expect(comps.map((c) => c.name)).toEqual(["comp_2", "comp_3"]);
    expect(comps.map((c) => c.parameters?.operand)).toEqual(["add", "screen"]);

    // Ends on a single output Null.
    const nulls = bodies.filter((b) => b.type === "nullTOP");
    expect(nulls).toHaveLength(1);
    expect(nulls[0]?.name).toBe("out1");

    // It has a visual output, so a preview image is attempted/returned.
    expect(result.content.some((c) => c.type === "image")).toBe(true);
  });

  it("maps friendly blend labels to real TD Composite operands (lighten→lightercolor, darken→darkercolor)", async () => {
    const bodies = captureCreateBodies();
    captureExecScripts();
    await createLayerStackImpl(makeCtx(), {
      name: "layer_stack",
      parent_path: "/project1",
      count: 4,
      resolution: [1280, 720],
      layers: [
        { blend: "over", opacity: 1 },
        { blend: "lighten", opacity: 1 },
        { blend: "darken", opacity: 1 },
        { blend: "multiply", opacity: 1 },
      ],
    });
    const comps = bodies.filter((b) => b.type === "compositeTOP");
    // comp_2..comp_4 — the bottom layer is the base (no composite).
    expect(comps.map((c) => c.parameters?.operand)).toEqual([
      "lightercolor",
      "darkercolor",
      "multiply",
    ]);
  });

  it("count-default path builds N test-source layers (no explicit sources) and one Null", async () => {
    const bodies = captureCreateBodies();
    captureExecScripts();
    const result = await createLayerStackImpl(makeCtx(), {
      name: "layer_stack",
      parent_path: "/project1",
      count: 4,
      resolution: [1280, 720],
      // layers omitted → 4 built-in test-source layers.
    });
    expect(result.isError).toBeFalsy();

    // No external sources, so no Select TOPs — the layers use built-in generators instead.
    expect(bodies.some((b) => b.type === "selectTOP")).toBe(false);
    expect(bodies.filter((b) => b.type === "levelTOP")).toHaveLength(4);
    // 4 layers → 3 Composites above the base.
    expect(bodies.filter((b) => b.type === "compositeTOP")).toHaveLength(3);
    // Built-in test sources are created (named sel_1..sel_4) so it previews standalone.
    const testSources = bodies.filter((b) => /^sel_\d$/.test(b.name ?? ""));
    expect(testSources).toHaveLength(4);
    expect(testSources.every((b) => b.type !== "selectTOP")).toBe(true);

    const nulls = bodies.filter((b) => b.type === "nullTOP");
    expect(nulls).toHaveLength(1);
    expect(nulls[0]?.name).toBe("out1");
  });

  it("exposes a per-layer control strip: Opacity (float, seeded), Blend (menu of the 7 modes), Mute + Solo (toggles)", async () => {
    captureCreateBodies();
    const scripts = captureExecScripts();
    await createLayerStackImpl(makeCtx(), {
      name: "layer_stack",
      parent_path: "/project1",
      count: 4,
      resolution: [1280, 720],
      layers: [
        { blend: "over", opacity: 0.9 },
        { blend: "add", opacity: 0.4 },
      ],
    });
    const controls = panelControls(scripts);

    // Two layers → Opacity1/2, Blend1/2, Mute1/2, Solo1/2.
    for (const i of [1, 2]) {
      const op = controls.find((c) => c.name === `Opacity${i}`);
      expect(op?.type).toBe("float");
      const blend = controls.find((c) => c.name === `Blend${i}`);
      expect(blend?.type).toBe("menu");
      expect(blend?.menu_items).toEqual([
        "over",
        "add",
        "multiply",
        "screen",
        "difference",
        "lighten",
        "darken",
      ]);
      expect(controls.find((c) => c.name === `Mute${i}`)?.type).toBe("toggle");
      expect(controls.find((c) => c.name === `Solo${i}`)?.type).toBe("toggle");
    }

    // Opacity controls are seeded from the per-layer opacity.
    expect(controls.find((c) => c.name === "Opacity1")?.default).toBe(0.9);
    expect(controls.find((c) => c.name === "Opacity2")?.default).toBe(0.4);

    // The base layer's Blend drives nothing (no Composite); higher layers bind the operand.
    expect(controls.find((c) => c.name === "Blend1")?.bind_to).toEqual([]);
    expect(controls.find((c) => c.name === "Blend2")?.bind_to).toEqual([
      "/project1/layer_stack/comp_2.operand",
    ]);
  });

  it("installs a Mute/Solo expression on each Level's opacity referencing the container's custom params", async () => {
    captureCreateBodies();
    const scripts = captureExecScripts();
    await createLayerStackImpl(makeCtx(), {
      name: "layer_stack",
      parent_path: "/project1",
      count: 4,
      resolution: [1280, 720],
      layers: [
        { blend: "over", opacity: 1 },
        { blend: "add", opacity: 1 },
      ],
    });
    // Each layer's Level opacity is pointed at a Mute/Solo expression and switched to
    // EXPRESSION mode. The expression is JSON-embedded twice (once for the path, once as the
    // .expr string literal), so the container op() refs are quote-escaped — assert on the
    // unambiguous par-name fragments and the mode switch instead.
    const expr = scripts.find((s) => s.includes("lvl_1") && s.includes(".par.opacity"));
    expect(expr).toBeDefined();
    expect(expr).toContain("type(_p.mode).EXPRESSION");
    expect(expr).toContain(".par.Mute1");
    expect(expr).toContain(".par.Opacity1");
    expect(expr).toContain(".par.Solo1");
    // The Solo logic references every layer's Solo (so soloing one mutes the rest).
    expect(expr).toContain(".par.Solo2");
  });

  it("defaults: layers omitted (count=4), resolution 1280x720, layer blend over / opacity 1", () => {
    const parsed = createLayerStackSchema.parse({});
    expect(parsed.name).toBe("layer_stack");
    expect(parsed.parent_path).toBe("/project1");
    expect(parsed.count).toBe(4);
    expect(parsed.layers).toBeUndefined();
    expect(parsed.resolution).toEqual([1280, 720]);
    const layer = createLayerStackSchema.parse({ layers: [{ source: "/x" }] }).layers?.[0];
    expect(layer?.blend).toBe("over");
    expect(layer?.opacity).toBe(1);
  });

  it("rejects out-of-range count, opacity, and an unknown blend at the schema boundary", () => {
    expect(() => createLayerStackSchema.parse({ count: 1 })).toThrow();
    expect(() => createLayerStackSchema.parse({ count: 9 })).toThrow();
    expect(() => createLayerStackSchema.parse({ layers: [{ opacity: 2 }] })).toThrow();
    expect(() => createLayerStackSchema.parse({ layers: [{ blend: "burn" }] })).toThrow();
  });

  it("does not throw and returns an isError result when the bridge reports a fatal", async () => {
    // A node-create that 500s makes the client throw a TdError; runBuild converts it to a
    // friendly isError result rather than letting it escape the handler.
    server.use(
      http.post(`${TD_BASE}/api/nodes`, () =>
        HttpResponse.json({ ok: false, error: "boom" }, { status: 500 }),
      ),
    );
    const result = await createLayerStackImpl(makeCtx(), {
      name: "layer_stack",
      parent_path: "/project1",
      count: 4,
      resolution: [1280, 720],
    });
    expect(result.isError).toBe(true);
    expect(result.content.some((c) => c.type === "text")).toBe(true);
  });
});
