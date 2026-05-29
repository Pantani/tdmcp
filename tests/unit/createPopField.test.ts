import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { createPopFieldImpl, createPopFieldSchema } from "../../src/tools/layer1/createPopField.js";
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

// All defaulted schema fields are required in the impl's inferred arg type, so every call passes
// them explicitly (the schema defaults are asserted separately below).
const BASE_ARGS = {
  name: "pop_field",
  parent_path: "/project1",
  count: 10000,
  pattern: "noise" as const,
  point_size: 2,
  spin: 10,
  resolution: [1280, 720] as [number, number],
};

describe("create_pop_field", () => {
  it("builds the POP generator chain and an output Null TOP (noise pattern)", async () => {
    const bodies = captureCreateBodies();
    captureExecScripts();
    const result = await createPopFieldImpl(makeCtx(), { ...BASE_ARGS });
    expect(result.isError).toBeFalsy();

    // The noise pattern uses a Point Generator POP as the generator…
    const generator = bodies.find((b) => b.name === "generator");
    expect(generator?.type).toBe("pointgeneratorPOP");
    // …displaced by a Noise POP…
    expect(bodies.some((b) => b.type === "noisePOP")).toBe(true);
    // …spun by a Transform POP…
    expect(bodies.some((b) => b.type === "transformPOP" && b.name === "spin")).toBe(true);
    // …bridged to the SOP render world via POP to SOP inside a Geometry COMP…
    expect(bodies.some((b) => b.type === "poptoSOP")).toBe(true);
    expect(bodies.some((b) => b.type === "geometryCOMP")).toBe(true);
    expect(bodies.some((b) => b.type === "renderTOP")).toBe(true);
    // …always ending on a Null TOP (the stable output handle).
    expect(bodies.some((b) => b.type === "nullTOP" && b.name === "out1")).toBe(true);
  });

  it("exposes PointSize and Spin controls seeded from the args", async () => {
    const scripts = captureExecScripts();
    await createPopFieldImpl(makeCtx(), { ...BASE_ARGS, point_size: 5, spin: 45 });
    const controls = panelControls(scripts);
    const size = controls.find((c) => c.name === "PointSize");
    expect(size?.type).toBe("float");
    expect(size?.default).toBe(5);
    const spin = controls.find((c) => c.name === "Spin");
    expect(spin?.type).toBe("float");
    expect(spin?.default).toBe(45);
  });

  it("writes the spin expression and the requested point count into the bridge scripts", async () => {
    const scripts = captureExecScripts();
    await createPopFieldImpl(makeCtx(), { ...BASE_ARGS, count: 25000, spin: 30 });
    // Transform POP gets a time-driven rotation expression.
    expect(scripts.some((s) => s.includes("absTime.seconds * 30"))).toBe(true);
    // Point Generator POP is asked for the requested count (set defensively via setattr).
    expect(scripts.some((s) => s.includes("numpoints") && s.includes("25000"))).toBe(true);
  });

  it("records the unverified POP probe info (op types + render path) in extra", async () => {
    captureExecScripts();
    const result = await createPopFieldImpl(makeCtx(), { ...BASE_ARGS });
    const text = result.content.find((c) => c.type === "text") as { text: string } | undefined;
    expect(text?.text).toContain("Experimental");
    // The JSON block (fenced) carries the probe record.
    const json = /```json\n([\s\S]*?)\n```/.exec(text?.text ?? "")?.[1] ?? "";
    const data = JSON.parse(json) as {
      unverified?: { pop_op_types?: unknown; render_path?: string };
    };
    expect(Array.isArray(data.unverified?.pop_op_types)).toBe(true);
    expect((data.unverified?.pop_op_types as string[]).length).toBeGreaterThan(0);
    expect(data.unverified?.render_path).toContain("poptoSOP");
  });

  it("grid pattern uses a Grid POP, sphere uses a Sphere POP", async () => {
    const gridBodies = captureCreateBodies();
    captureExecScripts();
    await createPopFieldImpl(makeCtx(), { ...BASE_ARGS, pattern: "grid" });
    expect(gridBodies.some((b) => b.name === "generator" && b.type === "gridPOP")).toBe(true);
    // No Noise POP in the grid path.
    expect(gridBodies.some((b) => b.type === "noisePOP")).toBe(false);

    server.resetHandlers();
    const sphereBodies = captureCreateBodies();
    captureExecScripts();
    await createPopFieldImpl(makeCtx(), { ...BASE_ARGS, pattern: "sphere" });
    expect(sphereBodies.some((b) => b.name === "generator" && b.type === "spherePOP")).toBe(true);
  });

  it("returns a friendly error (never throws) when node creation fails on the bridge", async () => {
    server.use(
      http.post(`${TD_BASE}/api/nodes`, () =>
        HttpResponse.json({ ok: false, error: "boom" }, { status: 500 }),
      ),
    );
    const result = await createPopFieldImpl(makeCtx(), { ...BASE_ARGS });
    expect(result.isError).toBe(true);
    const text = result.content.find((c) => c.type === "text") as { text: string } | undefined;
    expect(typeof text?.text).toBe("string");
  });

  it("validates inputs at the schema boundary and applies sensible defaults", () => {
    // Defaults.
    expect(createPopFieldSchema.parse({}).name).toBe("pop_field");
    expect(createPopFieldSchema.parse({}).pattern).toBe("noise");
    expect(createPopFieldSchema.parse({}).count).toBe(10000);
    expect(createPopFieldSchema.parse({}).point_size).toBe(2);
    expect(createPopFieldSchema.parse({}).spin).toBe(10);
    expect(createPopFieldSchema.parse({}).resolution).toEqual([1280, 720]);
    // Rejections.
    expect(() => createPopFieldSchema.parse({ pattern: "blobs" })).toThrow();
    expect(() => createPopFieldSchema.parse({ count: 0 })).toThrow();
    expect(() => createPopFieldSchema.parse({ count: 2000000 })).toThrow();
    expect(() => createPopFieldSchema.parse({ point_size: -1 })).toThrow();
  });
});
