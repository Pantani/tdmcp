import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  createPopParticleSystemImpl,
  createPopParticleSystemSchema,
} from "../../src/tools/layer1/createPopParticleSystem.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CreatedNodeBody {
  parent_path: string;
  type: string;
  name?: string;
  parameters?: Record<string, unknown>;
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

/**
 * Decode the base64 payload from a buildPopChain script (which uses buildPayloadScript).
 * The chain script pattern: base64.b64decode("<b64>")
 */
function decodeScriptPayload(script: string): Record<string, unknown> | null {
  const m = /b64decode\("([^"]+)"\)/.exec(script);
  if (!m?.[1]) return null;
  try {
    return JSON.parse(Buffer.from(m[1], "base64").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Smarter exec mock:
 * - Scripts containing b64decode with a decodable chain payload → PopChainReport
 * - Scripts containing appendCustomPage → ExposeControlsResult
 * - All others → empty stdout (fire-and-forget callers ignore return)
 */
function mockExec(chainWarnings: string[] = [], container = "/project1/pop_particle_system") {
  const capturedScripts: string[] = [];
  server.use(
    http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
      const body = (await request.json()) as { script: string };
      capturedScripts.push(body.script);
      let stdout: string;
      const payload = decodeScriptPayload(body.script);
      if (payload !== null && Array.isArray(payload.chain)) {
        // buildPopChain bridge pass — return a PopChainReport
        stdout = JSON.stringify({
          container,
          created: [
            { name: "particles", path: `${container}/particles`, type: "particlePOP" },
            { name: "trail", path: `${container}/trail`, type: "feedbackPOP" },
            { name: "force_lookup", path: `${container}/force_lookup`, type: "lookuptexturePOP" },
            { name: "field_viz", path: `${container}/field_viz`, type: "fieldPOP" },
            { name: "out_pop", path: `${container}/out_pop`, type: "nullPOP" },
          ],
          connections: [],
          output_path: `${container}/out_pop`,
          warnings: chainWarnings,
          unverified: "POPs are Experimental",
        });
      } else if (body.script.includes("appendCustomPage")) {
        // exposeControls pass — return an ExposeControlsResult
        stdout = JSON.stringify({ created: [], bound: [], warnings: [] });
      } else {
        // layout / placeInGrid / setPar / other fire-and-forget — safe no-op
        stdout = "";
      }
      return HttpResponse.json({ ok: true, data: { result: null, stdout } });
    }),
  );
  return capturedScripts;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

function parseJsonBlock(text: string): Record<string, unknown> {
  const m = /```json\n([\s\S]*?)\n```/.exec(text)?.[1] ?? "{}";
  return JSON.parse(m) as Record<string, unknown>;
}

const BASE_ARGS = {
  name: "pop_particle_system",
  parent_path: "/project1",
  emission_rate: 5000,
  lifetime: 4.0,
  force_texture_path: undefined as string | undefined,
  feedback_gain: 0.92,
  output: "particles" as const,
  resolution: [1280, 720] as [number, number],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("create_pop_particle_system", () => {
  /**
   * Case 1: Happy path defaults
   * Assert chain entries, force_default noiseTOP creation, output_top_path, isError !== true.
   */
  it("happy path defaults — creates POP chain + force_default noiseTOP + renders to out1", async () => {
    const bodies = captureCreateBodies();
    const scripts = mockExec();

    const result = await createPopParticleSystemImpl(makeCtx(), { ...BASE_ARGS });
    expect(result.isError).toBeFalsy();

    // force_default noiseTOP is created (no force_texture_path supplied)
    expect(bodies.some((b) => b.type === "noiseTOP" && b.name === "force_default")).toBe(true);

    // The chain script payload contains the force_default path in extra_inputs[0]
    const chainScript = scripts.find((s) => {
      const p = decodeScriptPayload(s);
      return p !== null && Array.isArray(p.chain);
    });
    expect(chainScript).toBeDefined();
    const payload = decodeScriptPayload(chainScript ?? "") as {
      chain: Array<{ name?: string; extra_inputs?: string[] }>;
    };
    const lookupEntry = payload.chain.find((e) => e.name === "force_lookup");
    expect(lookupEntry?.extra_inputs?.[0]).toContain("force_default");

    // Render rig nodes
    expect(bodies.some((b) => b.type === "geometryCOMP" && b.name === "geo")).toBe(true);
    expect(bodies.some((b) => b.type === "poptoSOP")).toBe(true);
    expect(bodies.some((b) => b.type === "renderTOP")).toBe(true);
    expect(bodies.some((b) => b.type === "nullTOP" && b.name === "out1")).toBe(true);

    // output_top_path present in result text
    expect(textOf(result)).toContain("out1");
  });

  /**
   * Case 2: Custom force_texture_path
   * Supplies "/project1/cam_in"; no force_default noiseTOP should be created.
   */
  it("custom force_texture_path — passes it to chain and skips force_default noiseTOP", async () => {
    const bodies = captureCreateBodies();
    const scripts = mockExec();

    const result = await createPopParticleSystemImpl(makeCtx(), {
      ...BASE_ARGS,
      force_texture_path: "/project1/cam_in",
    });
    expect(result.isError).toBeFalsy();

    // No force_default noiseTOP should be created
    expect(bodies.some((b) => b.name === "force_default")).toBe(false);

    // The force path "/project1/cam_in" appears in the chain script payload
    const chainScript = scripts.find((s) => {
      const p = decodeScriptPayload(s);
      return p !== null && Array.isArray(p.chain);
    });
    expect(chainScript).toBeDefined();
    const payload = decodeScriptPayload(chainScript ?? "") as {
      chain: Array<{ name?: string; extra_inputs?: string[] }>;
    };
    const lookupEntry = payload.chain.find((e) => e.name === "force_lookup");
    expect(lookupEntry?.extra_inputs?.[0]).toBe("/project1/cam_in");
  });

  /**
   * Case 3: Missing force texture warning from buildPopChain is bubbled up.
   * The result still succeeds (not an error), but warnings[] includes the upstream warning.
   */
  it("bubbles buildPopChain warnings into the final result", async () => {
    captureCreateBodies();
    mockExec(["extra[2.0] /project1/bad_top: node not found"]);

    const result = await createPopParticleSystemImpl(makeCtx(), { ...BASE_ARGS });
    expect(result.isError).toBeFalsy();

    // The chain warnings must appear somewhere in the result — either in warnings[]
    // (via extra spread) or in the summary text.
    const text = textOf(result);
    const data = parseJsonBlock(text);
    const warnings = (data.warnings as string[] | undefined) ?? [];
    const hasWarning = warnings.some((w) => w.includes("bad_top")) || text.includes("bad_top");
    expect(hasWarning).toBe(true);
  });

  /**
   * Case 4: output mode "composite" — a compositeTOP is created and nullTOP wires from it.
   */
  it("output=composite creates a compositeTOP and wires nullTOP from it", async () => {
    const bodies = captureCreateBodies();
    mockExec();

    const result = await createPopParticleSystemImpl(makeCtx(), {
      ...BASE_ARGS,
      output: "composite",
    });
    expect(result.isError).toBeFalsy();

    expect(bodies.some((b) => b.type === "compositeTOP")).toBe(true);
    // Two renderTOPs (particle + field)
    expect(bodies.filter((b) => b.type === "renderTOP").length).toBeGreaterThanOrEqual(2);
    expect(bodies.some((b) => b.type === "nullTOP" && b.name === "out1")).toBe(true);
  });

  /**
   * Case 5: Invalid emission_rate rejected by Zod before any bridge call.
   */
  it("rejects emission_rate=-1 at the schema boundary", () => {
    const r = createPopParticleSystemSchema.safeParse({ emission_rate: -1 });
    expect(r.success).toBe(false);
  });

  it("rejects non-positive and fractional output resolution", () => {
    expect(createPopParticleSystemSchema.safeParse({ resolution: [0, 720] }).success).toBe(false);
    expect(createPopParticleSystemSchema.safeParse({ resolution: [1280, -1] }).success).toBe(false);
    expect(createPopParticleSystemSchema.safeParse({ resolution: [1280.5, 720] }).success).toBe(
      false,
    );
    expect(createPopParticleSystemSchema.safeParse({ resolution: [1280, 720] }).success).toBe(true);
  });

  /**
   * Case 6: Fail-forward when buildPopChain warns (feedback_pop create warning).
   * null_pop output is still wired, output_top_path is non-null, warnings[] has the warning.
   */
  it("fail-forward — chain warning does not prevent output_top_path from being set", async () => {
    captureCreateBodies();
    mockExec(["create[1] feedbackPOP failed: some td error"]);

    const result = await createPopParticleSystemImpl(makeCtx(), { ...BASE_ARGS });
    expect(result.isError).toBeFalsy();

    const text = textOf(result);
    expect(text).toContain("out1");

    const data = parseJsonBlock(text);
    expect(data.output_top_path).toBeTruthy();

    // feedbackPOP warning must surface somewhere
    const warnings = (data.warnings as string[] | undefined) ?? [];
    const hasWarning =
      warnings.some((w) => w.includes("feedbackPOP")) || text.includes("feedbackPOP");
    expect(hasWarning).toBe(true);
  });
});
