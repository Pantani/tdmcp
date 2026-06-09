import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  createPopGrowthImpl,
  createPopGrowthSchema,
} from "../../src/tools/layer1/createPopGrowth.js";
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

/** Returns a fake PopChainReport JSON string. */
function chainReportJson(containerPath: string, warnings: string[] = []): string {
  return JSON.stringify({
    container: containerPath,
    created: [
      { name: "emit", path: `${containerPath}/emit`, type: "particlePOP" },
      { name: "noise", path: `${containerPath}/noise`, type: "noisePOP" },
      { name: "force", path: `${containerPath}/force`, type: "forcePOP" },
      { name: "growth_fb", path: `${containerPath}/growth_fb`, type: "feedbackPOP" },
    ],
    connections: [],
    output_path: `${containerPath}/growth_fb`,
    warnings,
    unverified: "POPs are Experimental",
  });
}

/**
 * Installs an exec handler that returns a valid chain report for any script that
 * carries a base64 POP chain payload, and an empty stdout for all other exec calls.
 * Returns the list of decoded payloads (one per chain-script exec).
 */
function captureChainPayloads(): Array<Record<string, unknown>> {
  const captured: Array<Record<string, unknown>> = [];
  server.use(
    http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
      const body = (await request.json()) as { script: string };
      const b64 = /b64decode\("([^"]+)"\)/.exec(body.script)?.[1];

      // Distinguish the POP chain script (has `_p["chain"]` marker) from other b64 scripts.
      if (b64 !== undefined && body.script.includes('_p["chain"]')) {
        const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as Record<
          string,
          unknown
        >;
        captured.push(payload);
        const container =
          typeof payload.parent === "string" ? payload.parent : "/project1/pop_growth";
        return HttpResponse.json({
          ok: true,
          data: { result: null, stdout: chainReportJson(container) },
        });
      }

      // Control panel scripts need a minimal ExposeControlsResult JSON so parsePythonReport
      // in exposeControls doesn't throw. Return an empty-but-valid report.
      if (b64 !== undefined && body.script.includes("appendCustomPage")) {
        const controlsReport = JSON.stringify({ created: [], bound: [], warnings: [] });
        return HttpResponse.json({
          ok: true,
          data: { result: null, stdout: controlsReport },
        });
      }

      // All other exec calls (layout, placement, geometry cleanup, etc.) — return empty stdout.
      return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
    }),
  );
  return captured;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((c): c is { type: string; text: string } => c.type === "text" && c.text !== undefined)
    .map((c) => c.text)
    .join("\n");
}

function jsonBlockOf(result: {
  content: Array<{ type: string; text?: string }>;
}): Record<string, unknown> {
  const text = textOf(result);
  const match = /```json\n([\s\S]*?)\n```/.exec(text);
  if (!match?.[1]) return {};
  return JSON.parse(match[1]) as Record<string, unknown>;
}

// All defaulted fields are required in the impl's arg type — pass them explicitly.
const BASE_ARGS = {
  mode: "dendritic" as const,
  name: "pop_growth",
  parent_path: "/project1",
  seed: 1,
  max_points: 50_000,
  resolution: [1280, 720] as [number, number],
  expose_controls: true,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("create_pop_growth", () => {
  it("dendritic mode applies preset defaults (birth=12, inputmul=0.95)", async () => {
    const payloads = captureChainPayloads();
    const result = await createPopGrowthImpl(makeCtx(), { ...BASE_ARGS, mode: "dendritic" });
    expect(result.isError).toBeFalsy();

    expect(payloads).toHaveLength(1);
    const chain = payloads[0]?.chain as Array<{ name: string; params: Record<string, number> }>;
    const emit = chain.find((c) => c.name === "emit");
    const fb = chain.find((c) => c.name === "growth_fb");
    expect(emit?.params.birth).toBe(12);
    expect(fb?.params.inputmul).toBe(0.95);

    const text = textOf(result);
    expect(text).toContain("mode=dendritic");
  });

  it("coral mode applies preset defaults (birth=40, inputmul=0.85, force.scale=1.8)", async () => {
    const payloads = captureChainPayloads();
    await createPopGrowthImpl(makeCtx(), { ...BASE_ARGS, mode: "coral" });

    expect(payloads).toHaveLength(1);
    const chain = payloads[0]?.chain as Array<{ name: string; params: Record<string, number> }>;
    const emit = chain.find((c) => c.name === "emit");
    const force = chain.find((c) => c.name === "force");
    const fb = chain.find((c) => c.name === "growth_fb");
    expect(emit?.params.birth).toBe(40);
    expect(force?.params.scale).toBe(1.8);
    expect(fb?.params.inputmul).toBe(0.85);
  });

  it("lichen mode applies preset defaults (birth=8, threshold=0.7, force.scale=0.5)", async () => {
    const payloads = captureChainPayloads();
    const result = await createPopGrowthImpl(makeCtx(), { ...BASE_ARGS, mode: "lichen" });
    expect(result.isError).toBeFalsy();

    const chain = payloads[0]?.chain as Array<{ name: string; params: Record<string, number> }>;
    const emit = chain.find((c) => c.name === "emit");
    const force = chain.find((c) => c.name === "force");
    expect(emit?.params.birth).toBe(8);
    expect(force?.params.scale).toBe(0.5);

    // threshold carried through to the extra block
    const data = jsonBlockOf(result);
    expect(data.threshold).toBe(0.7);
  });

  it("custom override beats preset (growth_rate=99 wins over coral=40)", async () => {
    const payloads = captureChainPayloads();
    const result = await createPopGrowthImpl(makeCtx(), {
      ...BASE_ARGS,
      mode: "coral",
      growth_rate: 99,
    });
    expect(result.isError).toBeFalsy();

    const chain = payloads[0]?.chain as Array<{ name: string; params: Record<string, number> }>;
    const emit = chain.find((c) => c.name === "emit");
    expect(emit?.params.birth).toBe(99);

    // Other coral defaults preserved
    const force = chain.find((c) => c.name === "force");
    expect(force?.params.scale).toBe(1.8);
  });

  it("invalid mode is rejected by Zod — no bridge calls made", () => {
    const r = createPopGrowthSchema.safeParse({ mode: "fungus" });
    expect(r.success).toBe(false);
  });

  it("feedback overflow warning is emitted (gain=1.5, decay=0)", async () => {
    captureChainPayloads();
    const result = await createPopGrowthImpl(makeCtx(), {
      ...BASE_ARGS,
      mode: "dendritic",
      feedback_gain: 1.5,
      decay: 0,
    });
    // Tool must succeed (not isError) — it warns but still builds
    expect(result.isError).toBeFalsy();

    const text = textOf(result);
    expect(text).toMatch(/feedback.*(diverg|unstable|gain)/i);

    // output_path still ends with /out1
    const data = jsonBlockOf(result);
    const outputPath = data.output_path as string | undefined;
    expect(typeof outputPath).toBe("string");
    expect(outputPath?.endsWith("/out1")).toBe(true);
  });

  it("bridge offline — returns isError:true friendly message, never throws", async () => {
    server.use(http.post(`${TD_BASE}/api/nodes`, () => HttpResponse.error()));
    server.use(http.post(`${TD_BASE}/api/exec`, () => HttpResponse.error()));
    const result = await createPopGrowthImpl(makeCtx(), { ...BASE_ARGS });
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(typeof text).toBe("string");
    expect(text.length).toBeGreaterThan(0);
  });
});
