import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { RecipeSchema } from "../../src/recipes/schema.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { buildFromRecipe } from "../../src/tools/layer1/orchestration.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

const library = new RecipeLibrary();

describe("RecipeLibrary", () => {
  it("loads the starter recipes", () => {
    const ids = library.list().map((r) => r.id);
    expect(ids).toContain("feedback_tunnel");
    expect(ids).toContain("noise_landscape");
    expect(ids).toContain("reaction_diffusion");
  });

  it("returns a recipe by id with nodes and connections", () => {
    const recipe = library.get("feedback_tunnel");
    expect(recipe).toBeDefined();
    expect(recipe?.nodes.length).toBeGreaterThan(0);
    expect(recipe?.connections.length).toBeGreaterThan(0);
  });

  it("matches recipes by tag", () => {
    // Several recipes carry the "feedback" tag (feedback_tunnel, performable_feedback_tunnel,
    // body_tracking_reactive); findByTags returns one of them — assert it actually matches the
    // requested tag rather than pinning a brittle id.
    const recipe = library.findByTags(["feedback"]);
    expect(recipe?.tags).toContain("feedback");
  });

  it("exposes uFeed/uKill as adjustable GLSL uniforms in reaction-diffusion", () => {
    const recipe = library.get("reaction_diffusion");
    const byName = new Map(recipe?.glsl_uniforms.map((u) => [u.name, u]));

    const uFeed = byName.get("uFeed");
    expect(uFeed).toMatchObject({ node: "glsl1", kind: "float", value: 0.055 });
    const uKill = byName.get("uKill");
    expect(uKill).toMatchObject({ node: "glsl1", kind: "float", value: 0.062 });

    // The shader must actually declare the uniforms it exposes, or they do nothing.
    expect(recipe?.glsl_code?.glsl1).toContain("uniform float uFeed");
    expect(recipe?.glsl_code?.glsl1).toContain("uniform float uKill");
  });

  it("ships live controls on the performable feedback tunnel, bound to real parameters", () => {
    const recipe = library.get("performable_feedback_tunnel");
    expect(recipe).toBeDefined();
    expect(recipe?.controls.map((c) => c.name)).toEqual(["Feedback", "Zoom", "Spin", "Blur"]);
    // Feedback drives the levelTOP's `brightness1` (it has no `gain`); Zoom drives the
    // transformTOP's `sx`/`sy` (not `scalex`/`scaley`) — the params that actually exist.
    const byName = new Map(recipe?.controls.map((c) => [c.name, c]));
    expect(byName.get("Feedback")?.bind_to).toEqual(["level1.brightness1"]);
    expect(byName.get("Zoom")?.bind_to).toEqual(["transform1.sx", "transform1.sy"]);
  });
});

describe("buildFromRecipe — GLSL uniforms", () => {
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

  it("raises numBlocks then sets per-block name/value sub-parameters", async () => {
    const recipe = RecipeSchema.parse({
      id: "uniform_probe",
      name: "Uniform Probe",
      nodes: [{ name: "glsl1", type: "glslTOP" }],
      glsl_uniforms: [
        { node: "glsl1", name: "uFeed", kind: "float", value: 0.055 },
        { node: "glsl1", name: "uKill", kind: "float", value: 0.062 },
        { node: "glsl1", name: "uTint", kind: "color", value: [0.1, 0.2, 0.3, 1] },
        { node: "glsl1", name: "uDir", kind: "vec", value: [1, 2, 3, 4] },
      ],
    });

    const execScripts: string[] = [];
    const patched: Array<Record<string, unknown>> = [];
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script: string };
        execScripts.push(body.script);
        return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
      }),
      http.patch(`${TD_BASE}/api/nodes/:seg`, async ({ request }) => {
        const body = (await request.json()) as { parameters: Record<string, unknown> };
        patched.push(body.parameters);
        return HttpResponse.json({
          ok: true,
          data: { path: "x", type: "glslTOP", name: "glsl1", parameters: body.parameters },
        });
      }),
    );

    const { builder } = await buildFromRecipe(makeCtx(), recipe, "/project1");
    expect(builder.warnings).toEqual([]);

    // numBlocks is raised once per (node, sequence) group. float + vec both bind through
    // the `vec` sequence, so the three of them share it (3 blocks); color is its own.
    const exec = execScripts.join("\n");
    expect(exec).toMatch(/\.seq\.vec\n_seq\.numBlocks = max\(_seq\.numBlocks, 3\)/);
    expect(exec).toMatch(/\.seq\.color\n_seq\.numBlocks = max\(_seq\.numBlocks, 1\)/);
    expect(exec).not.toContain(".seq.const");

    // The block name/value sub-parameters are set via the normal structured path.
    const all = Object.assign({}, ...patched) as Record<string, unknown>;
    // Two scalar floats occupy vec blocks 0 and 1, each filling only the x component.
    expect(all.vec0name).toBe("uFeed");
    expect(all.vec0valuex).toBe(0.055);
    expect(all.vec0valuey).toBeUndefined();
    expect(all.vec1name).toBe("uKill");
    expect(all.vec1valuex).toBe(0.062);
    // The vec uniform fills all four components in block 2.
    expect(all.vec2name).toBe("uDir");
    expect(all.vec2valuex).toBe(1);
    expect(all.vec2valuey).toBe(2);
    expect(all.vec2valuez).toBe(3);
    expect(all.vec2valuew).toBe(4);
    // The color uniform binds through the color sequence.
    expect(all.color0name).toBe("uTint");
    expect(all.color0rgbr).toBe(0.1);
    expect(all.color0rgbg).toBe(0.2);
    expect(all.color0rgbb).toBe(0.3);
    expect(all.color0alpha).toBe(1);
  });

  it("warns instead of throwing when a uniform targets an unknown node", async () => {
    const recipe = RecipeSchema.parse({
      id: "uniform_missing",
      name: "Uniform Missing",
      nodes: [{ name: "glsl1", type: "glslTOP" }],
      glsl_uniforms: [{ node: "ghost", name: "uX", kind: "float", value: 1 }],
    });

    const { builder } = await buildFromRecipe(makeCtx(), recipe, "/project1");
    expect(builder.warnings.some((w) => w.includes('unknown node "ghost"'))).toBe(true);
  });

  it("resolves a control's bind_to from recipe node names to real created paths", async () => {
    const recipe = RecipeSchema.parse({
      id: "ctrl_probe",
      name: "Control Probe",
      nodes: [{ name: "blur1", type: "blurTOP" }],
      controls: [
        { name: "Blur", type: "float", min: 0, max: 8, default: 2, bind_to: ["blur1.size"] },
      ],
    });
    const { controls } = await buildFromRecipe(makeCtx(), recipe, "/project1");
    // "blur1.size" → "/project1/ctrl_probe/blur1.size" (the real node path the panel can bind).
    expect(controls?.[0]?.bind_to?.[0]).toMatch(/\/project1\/ctrl_probe\/blur1\.size$/);
  });
});
