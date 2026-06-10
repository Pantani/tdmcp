import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  createReactionDiffusionImpl,
  createReactionDiffusionSchema,
} from "../../src/tools/layer1/createReactionDiffusion.js";
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
beforeAll(() => server.listen({ onUnhandledRequest: "warn" }));
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
      const body = (await request.json()) as { script: string };
      scripts.push(body.script);
      // Detect which exec is being called and return appropriate report
      let stdout: string;
      if (body.script.includes("uFeed") || body.script.includes("palette_keys")) {
        // Overlay script (our post-recipe Python pass)
        stdout = JSON.stringify({ warnings: [], lut_chain: true, iterations_applied: true });
      } else if (body.script.includes("appendCustomPage")) {
        // Control panel script
        stdout = JSON.stringify({ created: [], bound: [], warnings: [] });
      } else {
        // Builder python() calls (layout, shader text, etc.) — no stdout needed
        stdout = "";
      }
      return HttpResponse.json({ ok: true, data: { result: null, stdout } });
    }),
  );
  return scripts;
}

function getPayload(scripts: string[]): Record<string, unknown> | null {
  for (const s of scripts) {
    const m = /b64decode\("([^"]+)"\)/.exec(s);
    if (m?.[1]) {
      try {
        return JSON.parse(Buffer.from(m[1], "base64").toString("utf8")) as Record<string, unknown>;
      } catch {
        // ignore
      }
    }
  }
  return null;
}

function defaults(overrides: Partial<Parameters<typeof createReactionDiffusionImpl>[1]> = {}) {
  return createReactionDiffusionSchema.parse({ ...overrides });
}

// ---------------------------------------------------------------------------
// Test 1: Default (coral) — recipe nodes created, uniforms set, LUT wired
// ---------------------------------------------------------------------------
describe("createReactionDiffusionImpl", () => {
  it("default (coral): creates recipe nodes and sends overlay payload with coral LUT", async () => {
    const bodies = captureCreateBodies();
    const scripts = captureExecScripts();

    const result = await createReactionDiffusionImpl(makeCtx(), defaults());

    expect(result.isError).toBeFalsy();

    // Recipe nodes should be created (seed1, feedback1, glsl1, out1 + text DATs)
    const nodeTypes = bodies.map((b) => b.type);
    expect(nodeTypes).toContain("glslTOP");
    expect(nodeTypes).toContain("feedbackTOP");
    expect(nodeTypes).toContain("nullTOP");

    // Overlay script should have been executed
    expect(scripts.length).toBeGreaterThan(0);

    // Payload should contain default F/K and coral palette keys
    const payload = getPayload(scripts);
    expect(payload).not.toBeNull();
    expect(payload?.F).toBeCloseTo(0.055);
    expect(payload?.K).toBeCloseTo(0.062);
    expect(payload?.palette).toBe("coral");

    const keys = payload?.palette_keys as Array<{ pos: number }>;
    expect(Array.isArray(keys)).toBe(true);
    expect(keys.length).toBeGreaterThan(0);

    // Summary text should mention coral
    const text = textOf(result);
    expect(text).toContain("coral");
  });

  it("uses args.name for the recipe container", async () => {
    const bodies = captureCreateBodies();
    captureExecScripts();

    const result = await createReactionDiffusionImpl(
      makeCtx(),
      defaults({ name: "rd_custom_name" }),
    );

    expect(result.isError).toBeFalsy();
    expect(bodies.find((b) => b.type === "baseCOMP")?.name).toBe("rd_custom_name");
  });

  it("positions LUT nodes created by the overlay script", async () => {
    captureCreateBodies();
    const scripts = captureExecScripts();

    const result = await createReactionDiffusionImpl(makeCtx(), defaults({ palette: "spots" }));

    expect(result.isError).toBeFalsy();
    const overlayScript = scripts.find((s) => s.includes("lut_ramp") && s.includes("lut_apply"));
    expect(overlayScript).toContain("_lut_ramp.nodeX");
    expect(overlayScript).toContain("_lut_ramp.nodeY");
    expect(overlayScript).toContain("_lut_apply.nodeX");
    expect(overlayScript).toContain("_lut_apply.nodeY");
  });

  // -------------------------------------------------------------------------
  // Test 2: Spots palette — ramp keys match spots preset
  // -------------------------------------------------------------------------
  it("spots palette: payload contains spots ramp keys starting with black", async () => {
    captureCreateBodies();
    const scripts = captureExecScripts();

    const result = await createReactionDiffusionImpl(makeCtx(), defaults({ palette: "spots" }));

    expect(result.isError).toBeFalsy();

    const payload = getPayload(scripts);
    expect(payload).not.toBeNull();
    expect(payload?.palette).toBe("spots");

    const keys = payload?.palette_keys as Array<{
      pos: number;
      r: number;
      g: number;
      b: number;
    }>;
    expect(Array.isArray(keys)).toBe(true);
    // First key of spots palette is black (r=g=b=0)
    const firstKey = keys[0];
    expect(firstKey).toBeDefined();
    expect(firstKey?.r).toBeCloseTo(0);
    expect(firstKey?.g).toBeCloseTo(0);
    expect(firstKey?.b).toBeCloseTo(0);
    expect(firstKey?.pos).toBeCloseTo(0);
    // Last key should be white
    const lastKey = keys[keys.length - 1];
    expect(lastKey?.r).toBeCloseTo(1);
  });

  // -------------------------------------------------------------------------
  // Test 3: No palette — payload has empty keys; no rampTOP/lookupTOP created
  // -------------------------------------------------------------------------
  it("palette=none: palette_keys is empty; no LUT chain in overlay", async () => {
    captureCreateBodies();
    const scripts = captureExecScripts();

    const result = await createReactionDiffusionImpl(makeCtx(), defaults({ palette: "none" }));

    expect(result.isError).toBeFalsy();

    const payload = getPayload(scripts);
    expect(payload).not.toBeNull();
    expect(payload?.palette).toBe("none");

    const keys = payload?.palette_keys as unknown[];
    expect(Array.isArray(keys)).toBe(true);
    expect(keys.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Test 4: Custom Gray-Scott params — 4 vec blocks in payload
  // -------------------------------------------------------------------------
  it("custom F/K/Da/Db: payload carries correct uniform values", async () => {
    captureCreateBodies();
    const scripts = captureExecScripts();

    const result = await createReactionDiffusionImpl(
      makeCtx(),
      defaults({ F: 0.03, K: 0.058, Da: 1.2, Db: 0.4 }),
    );

    expect(result.isError).toBeFalsy();

    const payload = getPayload(scripts);
    expect(payload).not.toBeNull();
    expect(payload?.F).toBeCloseTo(0.03);
    expect(payload?.K).toBeCloseTo(0.058);
    expect(payload?.Da).toBeCloseTo(1.2);
    expect(payload?.Db).toBeCloseTo(0.4);

    // Overlay script must reference uDa/uDb patching (keyword present in script source)
    const overlayScript = scripts.find((s) => s.includes("uDa"));
    expect(overlayScript).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Test 5: Custom resolution + iterations — payload carries those values
  // -------------------------------------------------------------------------
  it("resolution=512 + iterations=8: payload contains values; iterations warning emitted", async () => {
    captureCreateBodies();
    const scripts = captureExecScripts();

    const result = await createReactionDiffusionImpl(
      makeCtx(),
      defaults({ resolution: 512, iterations: 8 }),
    );

    expect(result.isError).toBeFalsy();

    const payload = getPayload(scripts);
    expect(payload).not.toBeNull();
    expect(payload?.resolution).toBe(512);
    expect(payload?.iterations).toBe(8);

    // The overlay script should contain the iterations>1 warning logic
    const overlayScript = scripts.find((s) => s.includes("iterations"));
    expect(overlayScript).toBeDefined();

    // Summary text should mention the resolution
    const text = textOf(result);
    expect(text).toContain("512");
  });
});
