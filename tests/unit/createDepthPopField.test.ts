import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  createDepthPopFieldImpl,
  createDepthPopFieldSchema,
} from "../../src/tools/layer1/createDepthPopField.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/**
 * Mock exec for the auto-spin path: detects whether the script is a segmentation
 * script (by checking if the decoded b64 payload contains "tox_path") and returns
 * `segStdout` for it; the panel/layout scripts return a safe empty-ish result.
 */
function captureExecAutoSpin(segStdout: string): string[] {
  const scripts: string[] = [];
  // Safe panel result: matches ExposeControlsResult shape.
  const panelOk = JSON.stringify({ created: [], bound: [], warnings: [] });
  server.use(
    http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
      const body = (await request.json()) as { script: string };
      scripts.push(body.script);
      // Identify payload scripts by the b64decode marker.
      if (!body.script.includes("b64decode")) {
        return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
      }
      // Decode the payload to distinguish segmentation vs. panel/POP scripts.
      const b64Match = /b64decode\("([^"]+)"\)/.exec(body.script);
      if (b64Match?.[1]) {
        const decoded = Buffer.from(b64Match[1], "base64").toString("utf8");
        if (decoded.includes("tox_path")) {
          // Segmentation script — return the seg report.
          return HttpResponse.json({ ok: true, data: { result: null, stdout: segStdout } });
        }
      }
      // Panel / other payload scripts — return safe empty result.
      return HttpResponse.json({ ok: true, data: { result: null, stdout: panelOk } });
    }),
  );
  return scripts;
}

/**
 * Mock exec for the error path: segmentation payload scripts return `errStdout`,
 * others return safe empty results.
 */
function captureExecSegError(errStdout: string): string[] {
  const scripts: string[] = [];
  const panelOk = JSON.stringify({ created: [], bound: [], warnings: [] });
  server.use(
    http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
      const body = (await request.json()) as { script: string };
      scripts.push(body.script);
      if (!body.script.includes("b64decode")) {
        return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
      }
      const b64Match = /b64decode\("([^"]+)"\)/.exec(body.script);
      if (b64Match?.[1]) {
        const decoded = Buffer.from(b64Match[1], "base64").toString("utf8");
        if (decoded.includes("tox_path")) {
          return HttpResponse.json({ ok: true, data: { result: null, stdout: errStdout } });
        }
      }
      return HttpResponse.json({ ok: true, data: { result: null, stdout: panelOk } });
    }),
  );
  return scripts;
}

// All defaulted fields required when calling the impl directly.
const BASE_ARGS = {
  name: "depth_pop_field",
  parent_path: "/project1",
  particle_density: 20_000,
  scatter_mode: "displace" as const,
  depth_scale: 1.0,
  color_by_depth: true,
  invert_depth: false,
  point_size: 2,
  spin: 8,
  resolution: [1280, 720] as [number, number],
  expose_controls: true,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("create_depth_pop_field", () => {
  /**
   * Case 1: explicit depth_top_path — no segmentation spin-up, selectTOP par.top
   * set to the provided path, pointgeneratorPOP and lookup_texture_pop both created.
   */
  it("uses external depth TOP when depth_top_path is provided (no segmentation spin-up)", async () => {
    const bodies = captureCreateBodies();
    const scripts = captureExecScripts();

    const result = await createDepthPopFieldImpl(makeCtx(), {
      ...BASE_ARGS,
      depth_top_path: "/project1/some_depth",
    });

    expect(result.isError).toBeFalsy();

    // No segmentation engine tox load (no "tox_path" in any script)
    expect(scripts.some((s) => s.includes("tox_path"))).toBe(false);

    // in_depth selectTOP created and its par.top set to the provided path
    const inDepth = bodies.find((b) => b.name === "in_depth");
    expect(inDepth?.type).toBe("selectTOP");
    expect(scripts.some((s) => s.includes("/project1/some_depth"))).toBe(true);

    // pointgeneratorPOP created with the right count
    const gen = bodies.find((b) => b.name === "generator");
    expect(gen?.type).toBe("pointgeneratorPOP");
    expect(scripts.some((s) => s.includes("numpoints") && s.includes("20000"))).toBe(true);

    // lookup_texture_pop created for depth_lookup
    expect(bodies.some((b) => b.name === "depth_lookup" && b.type === "lookuptexturePOP")).toBe(
      true,
    );

    // stable output Null TOP always created
    expect(bodies.some((b) => b.name === "out1" && b.type === "nullTOP")).toBe(true);
  });

  /**
   * Case 2: no depth_top_path → auto-spin-up of setup_segmentation.
   * The exec mock returns a valid segmentation JSON report on the first call so
   * the impl can extract mask_top.
   */
  it("auto-spins up setup_segmentation when depth_top_path is omitted", async () => {
    // For the auto-spin path we need exec to return the segReport for the segmentation
    // bridge script (which uses buildPayloadScript / b64decode). Other exec calls
    // (layout, setParsDefensively, panel, etc.) return empty stdout — those callers
    // either ignore stdout or wrap parsePythonReport in a try/catch.
    const segReport = {
      engine: "/project1/depth_pop_field/mp_segmentation/MediaPipe",
      mask_top: "/project1/depth_pop_field/mp_segmentation/mask",
      warnings: [],
    };
    captureExecAutoSpin(JSON.stringify(segReport));

    const result = await createDepthPopFieldImpl(makeCtx(), { ...BASE_ARGS });
    expect(result.isError).toBeFalsy();

    // Result text must mention auto_segmentation mode
    const text = result.content.find((c): c is { type: "text"; text: string } => c.type === "text");
    expect(text?.text).toBeTruthy();
    // The JSON extra block should record depth_source.mode
    const match = /```json\n([\s\S]*?)\n```/.exec(text?.text ?? "");
    if (match?.[1]) {
      const data = JSON.parse(match[1]) as { depth_source?: { mode?: string } };
      expect(data.depth_source?.mode).toBe("auto_segmentation");
    }
  });

  /**
   * Case 3: scatter_mode=emit — transformPOP tz expression NOT set;
   * noise jitter amp is higher (emit bias).
   */
  it("scatter_mode=emit does not set transformPOP tz expr", async () => {
    captureCreateBodies();
    const scripts = captureExecScripts();

    await createDepthPopFieldImpl(makeCtx(), {
      ...BASE_ARGS,
      depth_top_path: "/project1/fake_depth",
      scatter_mode: "emit",
    });

    // No displace branch — no "sz" displacement write on the transformPOP
    expect(scripts.some((s) => s.includes('"sz"') && s.includes("displace"))).toBe(false);
    // Jitter amp is set higher (0.15) for emit/both modes
    expect(scripts.some((s) => s.includes("0.15"))).toBe(true);
  });

  /**
   * Case 4: scatter_mode=both — both transformPOP tz expr AND jitter amp bias active.
   */
  it("scatter_mode=both activates tz expr and higher jitter amp", async () => {
    captureCreateBodies();
    const scripts = captureExecScripts();

    await createDepthPopFieldImpl(makeCtx(), {
      ...BASE_ARGS,
      depth_top_path: "/project1/fake_depth",
      scatter_mode: "both",
    });

    // Displace branch: uniform sz scale applied via defensive par set
    expect(scripts.some((s) => s.includes('"sz"'))).toBe(true);
    expect(scripts.some((s) => s.includes("0.15"))).toBe(true);
  });

  /**
   * Case 5: color_by_depth=false — only one lookup_texture_pop created (no color_lookup).
   */
  it("color_by_depth=false creates only one lookup_texture_pop (no color_lookup)", async () => {
    const bodies = captureCreateBodies();
    captureExecScripts();

    await createDepthPopFieldImpl(makeCtx(), {
      ...BASE_ARGS,
      depth_top_path: "/project1/fake_depth",
      color_by_depth: false,
    });

    const lookupOps = bodies.filter((b) => b.type === "lookuptexturePOP");
    expect(lookupOps).toHaveLength(1);
    expect(lookupOps[0]?.name).toBe("depth_lookup");
    expect(bodies.some((b) => b.name === "color_lookup")).toBe(false);
  });

  /**
   * Case 6: particle_density Zod bounds — rejects 99 and 500_001, accepts 100 and 500_000.
   */
  it("rejects particle_density out of range and accepts boundary values", () => {
    expect(createDepthPopFieldSchema.safeParse({ particle_density: 99 }).success).toBe(false);
    expect(createDepthPopFieldSchema.safeParse({ particle_density: 500_001 }).success).toBe(false);
    expect(createDepthPopFieldSchema.safeParse({ particle_density: 100 }).success).toBe(true);
    expect(createDepthPopFieldSchema.safeParse({ particle_density: 500_000 }).success).toBe(true);
  });

  /**
   * Case 7: auto-spin failure — when segmentation returns an error (tox_missing),
   * tool must return errorResult surfacing the mediapipe install message,
   * without creating the POP chain.
   */
  it("surfaces segmentation tox_missing error and does not build POP chain", async () => {
    const bodies = captureCreateBodies();

    // The segmentation bridge script (b64decode) returns the tox_missing report.
    const segErrorReport = { error: "tox_missing", warnings: [] };
    captureExecSegError(JSON.stringify(segErrorReport));

    const result = await createDepthPopFieldImpl(makeCtx(), { ...BASE_ARGS });

    expect(result.isError).toBe(true);
    const text = result.content.find((c): c is { type: "text"; text: string } => c.type === "text");
    expect(text?.text).toContain("mediapipe-touchdesigner");

    // POP chain nodes (pointgeneratorPOP etc.) must NOT be created
    expect(bodies.some((b) => b.type === "pointgeneratorPOP")).toBe(false);
  });
});
