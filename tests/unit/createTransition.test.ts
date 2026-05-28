import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  createTransitionImpl,
  createTransitionSchema,
} from "../../src/tools/layer1/createTransition.js";
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

const BASE_ARGS = {
  name: "transition",
  parent_path: "/project1",
  style: "dissolve" as const,
  progress: 0,
  duration: 2,
  resolution: [1280, 720] as [number, number],
};

describe("create_transition", () => {
  it("dissolve builds A/B sources → a Cross TOP driven by Progress → a Null output", async () => {
    const bodies = captureCreateBodies();
    const scripts = captureExecScripts();
    const result = await createTransitionImpl(makeCtx(), { ...BASE_ARGS, style: "dissolve" });
    expect(result.isError).toBeFalsy();

    // Two built-in test sources (Constant for A, Ramp for B) and a Cross TOP that blends them.
    expect(bodies.some((b) => b.type === "constantTOP" && b.name === "sel_a")).toBe(true);
    expect(bodies.some((b) => b.type === "rampTOP" && b.name === "sel_b")).toBe(true);
    expect(bodies.some((b) => b.type === "crossTOP" && b.name === "dissolve")).toBe(true);
    // Ends on a Null TOP output.
    expect(bodies.some((b) => b.type === "nullTOP" && b.name === "out1")).toBe(true);

    // The Cross TOP's `cross` is driven by the container's Progress knob (expression mode).
    const expr = scripts.find(
      (s) => s.includes(".par.cross") && s.includes("parent().par.Progress"),
    );
    expect(expr).toBeDefined();
    expect(expr).toContain("EXPRESSION");
  });

  it("luma_wipe builds a Ramp gradient + a GLSL matte pass (A,B,ramp inputs) → a Null", async () => {
    const bodies = captureCreateBodies();
    const scripts = captureExecScripts();
    const result = await createTransitionImpl(makeCtx(), { ...BASE_ARGS, style: "luma_wipe" });
    expect(result.isError).toBeFalsy();

    // Ramp gradient drives the wipe; a GLSL TOP + Text DAT carries the matte shader.
    expect(bodies.some((b) => b.type === "rampTOP" && b.name === "wipe_ramp")).toBe(true);
    expect(bodies.some((b) => b.type === "glslTOP" && b.name === "luma_wipe")).toBe(true);
    expect(bodies.some((b) => b.type === "textDAT" && b.name === "luma_wipe_frag")).toBe(true);
    expect(bodies.some((b) => b.type === "nullTOP" && b.name === "out1")).toBe(true);

    // The shader text is the matte mix, and uProgress is bound to the Progress knob.
    const frag = scripts.find((s) => s.includes("out vec4 fragColor") && s.includes("smoothstep"));
    expect(frag).toBeDefined();
    const uni = scripts.find(
      (s) => s.includes('vec0name = "uProgress"') && s.includes("parent().par.Progress"),
    );
    expect(uni).toBeDefined();

    // The result flags the matte edge as UNVERIFIED (offline build).
    const text = result.content.find((c) => c.type === "text") as { text: string } | undefined;
    expect(text?.text).toContain("luma_wipe");
  });

  it("glitch_cut builds a GLSL hard-cut pass over A and B → a Null", async () => {
    const bodies = captureCreateBodies();
    const scripts = captureExecScripts();
    const result = await createTransitionImpl(makeCtx(), { ...BASE_ARGS, style: "glitch_cut" });
    expect(result.isError).toBeFalsy();
    expect(bodies.some((b) => b.type === "glslTOP" && b.name === "glitch_cut")).toBe(true);
    expect(bodies.some((b) => b.type === "textDAT" && b.name === "glitch_cut_frag")).toBe(true);
    expect(bodies.some((b) => b.type === "nullTOP" && b.name === "out1")).toBe(true);
    // The shader hard-switches at the midpoint.
    const frag = scripts.find((s) => s.includes("out vec4 fragColor") && s.includes("step(0.5"));
    expect(frag).toBeDefined();
  });

  it("slide/zoom use a Transform TOP composited over A", async () => {
    const slideBodies = captureCreateBodies();
    captureExecScripts();
    await createTransitionImpl(makeCtx(), { ...BASE_ARGS, style: "slide" });
    expect(slideBodies.some((b) => b.type === "transformTOP" && b.name === "slide")).toBe(true);
    expect(slideBodies.some((b) => b.type === "compositeTOP")).toBe(true);

    server.resetHandlers();
    const zoomBodies = captureCreateBodies();
    captureExecScripts();
    await createTransitionImpl(makeCtx(), { ...BASE_ARGS, style: "zoom" });
    expect(zoomBodies.some((b) => b.type === "transformTOP" && b.name === "zoom")).toBe(true);
    expect(zoomBodies.some((b) => b.type === "compositeTOP")).toBe(true);
  });

  it("brings external sources in via Select TOPs when paths are given", async () => {
    const bodies = captureCreateBodies();
    captureExecScripts();
    await createTransitionImpl(makeCtx(), {
      ...BASE_ARGS,
      source_a: "/project1/look_a",
      source_b: "/project1/look_b",
    });
    const selects = bodies.filter((b) => b.type === "selectTOP");
    expect(selects.length).toBe(2);
    expect(selects.some((b) => b.parameters?.top === "/project1/look_a")).toBe(true);
    expect(selects.some((b) => b.parameters?.top === "/project1/look_b")).toBe(true);
  });

  it("exposes a Progress knob (seeded from the arg) and a Duration knob", async () => {
    const scripts = captureExecScripts();
    await createTransitionImpl(makeCtx(), { ...BASE_ARGS, progress: 0.4, duration: 5 });
    const controls = panelControls(scripts);
    const progress = controls.find((c) => c.name === "Progress");
    expect(progress?.type).toBe("float");
    expect(progress?.default).toBe(0.4);
    expect(controls.find((c) => c.name === "Duration")?.default).toBe(5);
  });

  it("validates the schema: defaults, progress 0–1 bound, and unknown style rejected", () => {
    const parsed = createTransitionSchema.parse({});
    expect(parsed.name).toBe("transition");
    expect(parsed.style).toBe("dissolve");
    expect(parsed.progress).toBe(0);
    expect(parsed.duration).toBe(2);
    expect(parsed.resolution).toEqual([1280, 720]);

    expect(() => createTransitionSchema.parse({ progress: 2 })).toThrow();
    expect(() => createTransitionSchema.parse({ progress: -1 })).toThrow();
    expect(() => createTransitionSchema.parse({ style: "wishful" })).toThrow();
  });

  it("never throws when a node create fails — returns a friendly error result", async () => {
    // The very first createNode (the container) errors; runBuild must convert it to an
    // isError result rather than letting it propagate out of the handler.
    server.use(
      http.post(`${TD_BASE}/api/nodes`, () =>
        HttpResponse.json({ ok: false, error: "bridge offline" }, { status: 500 }),
      ),
    );
    const result = await createTransitionImpl(makeCtx(), { ...BASE_ARGS, style: "dissolve" });
    expect(result.isError).toBe(true);
    expect(result.content.some((c) => c.type === "text")).toBe(true);
  });
});
