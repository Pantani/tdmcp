import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  createPointerReactiveImpl,
  createPointerReactiveSchema,
} from "../../src/tools/layer1/createPointerReactive.js";
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

const baseArgs = {
  multitouch: false,
  demo: true,
  sensitivity: 1,
  resolution: [1280, 720] as [number, number],
  parent_path: "/project1",
};

describe("create_pointer_reactive", () => {
  it("builds a Mouse In CHOP and a 'pointer' Null CHOP bind point; summary mentions ['u']", async () => {
    const bodies = captureCreateBodies();
    captureExecScripts();
    const result = await createPointerReactiveImpl(makeCtx(), { ...baseArgs, demo: false });
    expect(result.isError).toBeFalsy();

    const mousein = bodies.find((b) => b.type === "mouseinCHOP");
    expect(mousein).toBeDefined();
    expect(mousein?.parameters).toMatchObject({
      posxname: "raw_u",
      posyname: "raw_v",
      lbuttonname: "button",
    });

    const pointer = bodies.find((b) => b.type === "nullCHOP" && b.name === "pointer");
    expect(pointer).toBeDefined();
    expect(pointer?.parent_path).toContain("pointer_reactive");

    const text = result.content.find((c) => c.type === "text") as { text: string } | undefined;
    expect(text?.text).toContain("['u']");
    expect(text?.text).toContain("pointer");
  });

  it("demo=false does not build the feedback-field demo chain and disables preview capture", async () => {
    const bodies = captureCreateBodies();
    captureExecScripts();
    const result = await createPointerReactiveImpl(makeCtx(), { ...baseArgs, demo: false });
    expect(result.isError).toBeFalsy();

    expect(bodies.some((b) => b.type === "feedbackTOP")).toBe(false);
    expect(bodies.some((b) => b.type === "circleTOP")).toBe(false);
    expect(bodies.some((b) => b.type === "compositeTOP")).toBe(false);
    // No image should be present since the output is a CHOP.
    expect(result.content.some((c) => c.type === "image")).toBe(false);
  });

  it("demo=true (default) builds the feedback-field demo chain ending in a Null TOP", async () => {
    const bodies = captureCreateBodies();
    captureExecScripts();
    const result = await createPointerReactiveImpl(makeCtx(), { ...baseArgs, demo: true });
    expect(result.isError).toBeFalsy();

    expect(bodies.some((b) => b.type === "feedbackTOP")).toBe(true);
    expect(bodies.some((b) => b.type === "circleTOP")).toBe(true);
    expect(bodies.some((b) => b.type === "compositeTOP")).toBe(true);
    expect(bodies.some((b) => b.type === "nullTOP" && b.name === "demo_out")).toBe(true);
  });

  it("wires transform tx/ty expressions to the pointer's u/v channels in the demo", async () => {
    captureCreateBodies();
    const scripts = captureExecScripts();
    await createPointerReactiveImpl(makeCtx(), { ...baseArgs, demo: true });
    const posExpr = scripts.find((s) => s.includes("par.tx.expr"));
    expect(posExpr).toBeDefined();
    expect(posExpr).toContain("pointer_reactive/pointer");
    expect(posExpr).toContain("['u']");
    expect(posExpr).toContain("['v']");
  });

  it("closes the feedback loop by pointing the feedback TOP at the composite", async () => {
    captureCreateBodies();
    const scripts = captureExecScripts();
    await createPointerReactiveImpl(makeCtx(), { ...baseArgs, demo: true });
    const closeLoop = scripts.find((s) => s.includes(".par.top = op("));
    expect(closeLoop).toBeDefined();
  });

  it("adds the per-frame cooker so the pointer Null stays live", async () => {
    captureCreateBodies();
    const scripts = captureExecScripts();
    await createPointerReactiveImpl(makeCtx(), { ...baseArgs, demo: false });
    const cooker = scripts.find((s) => s.includes("onFrameStart"));
    expect(cooker).toBeDefined();
    expect(cooker).toContain("op('pointer').cook(force=True)");
  });

  it("adds a multitouch-limitation warning when multitouch=true (still builds Mouse In path)", async () => {
    const bodies = captureCreateBodies();
    captureExecScripts();
    const result = await createPointerReactiveImpl(makeCtx(), { ...baseArgs, multitouch: true });
    expect(result.isError).toBeFalsy();
    expect(bodies.some((b) => b.type === "mouseinCHOP")).toBe(true);
    const text = result.content.find((c) => c.type === "text") as { text: string } | undefined;
    expect(text?.text.toLowerCase()).toContain("warning");
  });

  it("schema defaults: demo=true, sensitivity=1, multitouch=false", () => {
    const parsed = createPointerReactiveSchema.parse({});
    expect(parsed.demo).toBe(true);
    expect(parsed.sensitivity).toBe(1);
    expect(parsed.multitouch).toBe(false);
    expect(parsed.resolution).toEqual([1280, 720]);
    expect(parsed.parent_path).toBe("/project1");
  });

  it("clamps sensitivity to 0..8 at the schema boundary", () => {
    expect(() => createPointerReactiveSchema.parse({ sensitivity: 20 })).toThrow();
    expect(() => createPointerReactiveSchema.parse({ sensitivity: -1 })).toThrow();
  });

  it("never throws when node creation fails (bridge error surfaces as isError)", async () => {
    server.use(
      http.post(`${TD_BASE}/api/nodes`, () =>
        HttpResponse.json({ ok: false, error: { message: "TD offline" } }, { status: 502 }),
      ),
    );
    captureExecScripts();
    const result = await createPointerReactiveImpl(makeCtx(), baseArgs);
    expect(result.isError).toBe(true);
  });
});
