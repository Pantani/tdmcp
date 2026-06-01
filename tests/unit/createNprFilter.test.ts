import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  createNprFilterImpl,
  createNprFilterSchema,
  NPR_SHADER,
} from "../../src/tools/layer2/createNprFilter.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

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

interface RecordedCalls {
  creates: Array<{ parent_path: string; type: string; name?: string }>;
  execs: string[];
  batches: Array<{ action: string; source_path?: string; target_path?: string }>;
}

function captureCalls(): RecordedCalls {
  const calls: RecordedCalls = { creates: [], execs: [], batches: [] };
  server.use(
    http.post(`${TD_BASE}/api/nodes`, async ({ request }) => {
      const body = (await request.json()) as { parent_path: string; type: string; name?: string };
      calls.creates.push(body);
      const name = body.name ?? `${body.type.replace(/[^a-zA-Z0-9]/g, "").toLowerCase()}1`;
      return HttpResponse.json({
        ok: true,
        data: { path: `${body.parent_path}/${name}`, type: body.type, name },
      });
    }),
    http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
      const body = (await request.json()) as { script: string };
      calls.execs.push(body.script);
      return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
    }),
    http.post(`${TD_BASE}/api/batch`, async ({ request }) => {
      const body = (await request.json()) as {
        operations: Array<{
          action: string;
          source_path?: string;
          target_path?: string;
        }>;
      };
      for (const op of body.operations) calls.batches.push(op);
      return HttpResponse.json({
        ok: true,
        data: { results: body.operations.map((op) => ({ action: op.action, ok: true })) },
      });
    }),
  );
  return calls;
}

describe("create_npr_filter", () => {
  it("applies defaults from a minimal arg set", () => {
    const parsed = createNprFilterSchema.parse({ source_path: "/project1/render1" });
    expect(parsed).toMatchObject({
      source_path: "/project1/render1",
      parent_path: "/project1",
      name: "npr1",
      mode: "oil",
      radius: 4,
      sectors: 8,
      smoothness: 0.5,
      strength: 1,
      resolution: "input",
    });
  });

  it("creates select → glsl → null + frag DAT and wires them, with live-binding uniforms", async () => {
    const calls = captureCalls();
    const result = await createNprFilterImpl(makeCtx(), {
      source_path: "/project1/render1",
      parent_path: "/project1",
      name: "npr1",
      mode: "oil",
      radius: 4,
      sectors: 8,
      smoothness: 0.5,
      strength: 1,
      resolution: "input",
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("/project1/npr1_out");
    expect(text).toContain("oil");

    const types = calls.creates.map((c) => c.type);
    expect(types).toEqual(["selectTOP", "textDAT", "glslTOP", "nullTOP"]);

    // Two wiring calls (select→glsl, glsl→null) — go through batch fallback since
    // /api/connect 404s in the default mock.
    const connectOps = calls.batches.filter((b) => b.action === "connect");
    expect(connectOps).toHaveLength(2);
    expect(connectOps[0]).toMatchObject({
      source_path: "/project1/npr1_src",
      target_path: "/project1/npr1",
    });
    expect(connectOps[1]).toMatchObject({
      source_path: "/project1/npr1",
      target_path: "/project1/npr1_out",
    });

    // Single setup exec script carries: source TOP, shader text, pixeldat,
    // numBlocks bump, mode/sectors constants, and live-binding for radius/etc.
    const setup = calls.execs.find((s) => s.includes("vec0name") && s.includes("uMode"));
    expect(setup).toBeDefined();
    if (!setup) throw new Error("setup script not captured");
    expect(setup).toContain(".text =");
    expect(setup).toContain("pixeldat");
    expect(setup).toContain("vec0name = 'uMode'");
    expect(setup).toContain("vec0valuex = 0");
    expect(setup).toContain("vec1name = 'uSectors'");
    expect(setup).toContain("vec1valuex = 8");
    expect(setup).toContain("vec2name = 'uRadius'");
    expect(setup).toContain(".mode = type(");
    expect(setup).toContain(".EXPRESSION");
    expect(setup).toContain("vec3name = 'uSmoothness'");
    expect(setup).toContain("vec4name = 'uStrength'");
    expect(setup).toContain("parent().par.Radius");

    // Source TOP set on the Select TOP.
    expect(setup).toContain("/project1/render1");
  });

  it("encodes mode integers 0/1/2 per oil/pencil/watercolor", async () => {
    for (const [mode, expected] of [
      ["pencil", 1],
      ["watercolor", 2],
    ] as const) {
      const calls = captureCalls();
      await createNprFilterImpl(makeCtx(), {
        source_path: "/project1/render1",
        parent_path: "/project1",
        name: "npr1",
        mode,
        radius: 4,
        sectors: 8,
        smoothness: 0.5,
        strength: 1,
        resolution: "input",
      });
      const setup = calls.execs.find((s) => s.includes("vec0name"));
      expect(setup, `mode=${mode}`).toBeDefined();
      expect(setup).toContain(`vec0valuex = ${expected}`);
    }
  });

  it("encodes sectors=4 variant", async () => {
    const calls = captureCalls();
    await createNprFilterImpl(makeCtx(), {
      source_path: "/project1/render1",
      parent_path: "/project1",
      name: "npr1",
      mode: "oil",
      radius: 4,
      sectors: 4,
      smoothness: 0.5,
      strength: 1,
      resolution: "input",
    });
    const setup = calls.execs.find((s) => s.includes("vec1name"));
    expect(setup).toBeDefined();
    expect(setup).toContain("vec1valuex = 4");
  });

  it("surfaces a friendly isError when the bridge is offline", async () => {
    server.use(http.post(`${TD_BASE}/api/nodes`, () => HttpResponse.error()));
    const result = await createNprFilterImpl(makeCtx(), {
      source_path: "/project1/render1",
      parent_path: "/project1",
      name: "npr1",
      mode: "oil",
      radius: 4,
      sectors: 8,
      smoothness: 0.5,
      strength: 1,
      resolution: "input",
    });
    expect(result.isError).toBe(true);
  });

  it("exports the NPR_SHADER constant honoring TD GLSL gotchas", () => {
    expect(NPR_SHADER).toContain("out vec4 fragColor;");
    expect(NPR_SHADER).toContain("uniform float uMode;");
    expect(NPR_SHADER).toContain("TDOutputSwizzle(");
    expect(NPR_SHADER).toContain("sTD2DInputs[0]");
    expect(NPR_SHADER).not.toContain("uTime");
  });
});
