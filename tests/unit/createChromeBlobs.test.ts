import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { createChromeBlobsImpl } from "../../src/tools/layer1/createChromeBlobs.js";
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

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

/** Records every POST /api/nodes body and serves synthetic paths. */
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

// ---------------------------------------------------------------------------
// Case 1: default build — noise-based blob source
// ---------------------------------------------------------------------------

describe("create_chrome_blobs", () => {
  it("default build creates noiseTOP, blur, level, threshold, glslTOP, textDAT, compositeTOP, nullTOP", async () => {
    const bodies = captureCreateBodies();
    const result = await createChromeBlobsImpl(makeCtx(), {
      parent_path: "/project1",
      name: "chrome_blobs",
      count: 8,
      speed: 0.5,
      metal_color: "silver",
      background: "black",
    });

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("/project1/chrome_blobs");
    expect(text).toContain("out1");

    const types = bodies.map((b) => b.type);
    expect(types).toContain("noiseTOP");
    expect(types).toContain("blurTOP");
    expect(types).toContain("levelTOP");
    expect(types).toContain("thresholdTOP");
    expect(types).toContain("glslTOP");
    expect(types).toContain("textDAT");
    expect(types).toContain("compositeTOP");
    expect(types).toContain("nullTOP");

    // No selectTOP when no source_top_path is provided
    expect(types).not.toContain("selectTOP");
  });

  // ---------------------------------------------------------------------------
  // Case 2: external source uses selectTOP, no noiseTOP
  // ---------------------------------------------------------------------------

  it("external source_top_path uses selectTOP instead of noiseTOP", async () => {
    const bodies = captureCreateBodies();
    // Also capture PATCH bodies (setParams calls)
    const patches: Array<{ path: string; parameters: Record<string, unknown> }> = [];
    server.use(
      http.patch(`${TD_BASE}/api/nodes/:seg`, async ({ params, request }) => {
        const body = (await request.json()) as { parameters: Record<string, unknown> };
        const seg = decodeURIComponent(
          Array.isArray(params.seg) ? (params.seg[0] ?? "") : String(params.seg ?? ""),
        );
        patches.push({ path: seg, parameters: body.parameters });
        return HttpResponse.json({
          ok: true,
          data: { path: seg, type: "selectTOP", name: "select1", parameters: body.parameters },
        });
      }),
    );

    const result = await createChromeBlobsImpl(makeCtx(), {
      parent_path: "/project1",
      name: "chrome_blobs",
      source_top_path: "/project1/render1",
      count: 8,
      speed: 0.5,
      metal_color: "silver",
      background: "black",
    });

    expect(result.isError).toBeFalsy();

    const types = bodies.map((b) => b.type);
    expect(types).toContain("selectTOP");
    expect(types).not.toContain("noiseTOP");

    // The setParams call on the selectTOP must reference the external path
    const selPatch = patches.find((p) => p.parameters.top === "/project1/render1");
    expect(selPatch).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // Case 3: metal_color "gold" sets the correct GLSL uniform RGB
  // ---------------------------------------------------------------------------

  it("metal_color gold sets uMetalColor uniform to gold RGB values in GLSL python script", async () => {
    captureCreateBodies();
    const scripts: string[] = [];
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script: string };
        scripts.push(body.script);
        return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
      }),
    );

    await createChromeBlobsImpl(makeCtx(), {
      parent_path: "/project1",
      name: "chrome_blobs",
      count: 8,
      speed: 0.5,
      metal_color: "gold",
      background: "black",
    });

    // One of the python scripts must set uMetalColor with gold R ≈ 0.95
    const glslSetup = scripts.find((s) => s.includes("uMetalColor") && s.includes("vec0valuex"));
    expect(glslSetup).toBeDefined();
    // Gold R = 0.95, G = 0.8, B = 0.3
    expect(glslSetup).toContain("vec0valuex = 0.95");
    expect(glslSetup).toContain("vec0valuey = 0.8");
    expect(glslSetup).toContain("vec0valuez = 0.3");
  });

  // ---------------------------------------------------------------------------
  // Case 4: count drives blur1.size and threshold1.threshold
  // ---------------------------------------------------------------------------

  it("count=16 sets blur1 size and threshold1 parameter per formula", async () => {
    const bodies = captureCreateBodies();
    await createChromeBlobsImpl(makeCtx(), {
      parent_path: "/project1",
      name: "chrome_blobs",
      count: 16,
      speed: 0.5,
      metal_color: "silver",
      background: "black",
    });

    // blur1Size = 8 + 32/16 = 10
    const blur1 = bodies.find((b) => b.name === "blur1");
    expect(blur1?.parameters).toMatchObject({ size: 10 });

    // thresholdVal = min(0.4 + 16*0.01, 0.7) = min(0.56, 0.7) = 0.56
    const thresh = bodies.find((b) => b.name === "threshold1");
    expect(thresh?.parameters).toMatchObject({ threshold: 0.56 });
  });

  // ---------------------------------------------------------------------------
  // Case 5: result shape — JSON fence has container, created[], output, controls.added
  // ---------------------------------------------------------------------------

  it("result JSON fence contains container, created array, output, and controls summary", async () => {
    captureCreateBodies();
    const result = await createChromeBlobsImpl(makeCtx(), {
      parent_path: "/project1",
      name: "chrome_blobs",
      count: 8,
      speed: 0.5,
      metal_color: "silver",
      background: "black",
    });

    expect(result.isError).toBeFalsy();
    const text = textOf(result);

    // JSON fence must be present
    expect(text).toContain("```json");

    // Extract and parse the JSON block
    const match = /```json\n([\s\S]+?)\n```/.exec(text);
    expect(match).not.toBeNull();
    const json = JSON.parse(match?.[1] ?? "{}") as {
      container: string;
      created: string[];
      output: string;
      controls?: { added: string[] };
      metal_color: string;
      background: string;
      count: number;
    };

    expect(json.container).toContain("chrome_blobs");
    expect(Array.isArray(json.created)).toBe(true);
    expect(json.created.length).toBeGreaterThan(0);
    expect(json.output).toContain("out1");
    expect(json.metal_color).toBe("silver");
    expect(json.background).toBe("black");
    expect(json.count).toBe(8);
  });
});
