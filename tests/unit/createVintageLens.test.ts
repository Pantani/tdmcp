import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { createVintageLensImpl } from "../../src/tools/layer1/createVintageLens.js";
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

describe("createVintageLensImpl", () => {
  it("super8 preset — creates 4 glslTOP + 4 textDAT + selectTOP + nullTOP with preset strengths", async () => {
    const bodies = captureCreateBodies();
    const result = await createVintageLensImpl(makeCtx(), {
      parent_path: "/project1",
      name: "vintage_lens",
      source_top_path: "/project1/render1",
      era: "super8",
    });

    expect(result.isError).toBeFalsy();

    // Verify node types created.
    expect(bodies.filter((b) => b.type === "glslTOP").length).toBe(4);
    expect(bodies.filter((b) => b.type === "textDAT").length).toBe(4);
    expect(bodies.some((b) => b.type === "selectTOP")).toBe(true);
    expect(bodies.some((b) => b.name === "out1" && b.type === "nullTOP")).toBe(true);

    // Verify the 4 GLSL node names.
    expect(bodies.some((b) => b.name === "barrel" && b.type === "glslTOP")).toBe(true);
    expect(bodies.some((b) => b.name === "ca" && b.type === "glslTOP")).toBe(true);
    expect(bodies.some((b) => b.name === "vignette" && b.type === "glslTOP")).toBe(true);
    expect(bodies.some((b) => b.name === "grain" && b.type === "glslTOP")).toBe(true);

    // Verify preset strengths echoed in result text.
    const text = textOf(result);
    expect(text).toContain("super8");
    expect(text).toContain("0.18"); // distortion_strength
  });

  it("vhs preset — resolved tuple matches vhs strengths", async () => {
    captureCreateBodies();
    const result = await createVintageLensImpl(makeCtx(), {
      parent_path: "/project1",
      name: "vintage_lens",
      source_top_path: "/project1/render1",
      era: "vhs",
    });

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("vhs");
    // ca_strength 0.020 and distortion 0.08 for vhs.
    expect(text).toContain("0.02");
    expect(text).toContain("0.08");
  });

  it("16mm preset — resolved grain_amount is 0.10", async () => {
    captureCreateBodies();
    const result = await createVintageLensImpl(makeCtx(), {
      parent_path: "/project1",
      name: "vintage_lens",
      source_top_path: "/project1/render1",
      era: "16mm",
    });

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("0.1"); // grain_amount 0.10
  });

  it("80s_camcorder preset — resolved distortion_strength is 0.05", async () => {
    captureCreateBodies();
    const result = await createVintageLensImpl(makeCtx(), {
      parent_path: "/project1",
      name: "vintage_lens",
      source_top_path: "/project1/render1",
      era: "80s_camcorder",
    });

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("80s_camcorder");
    expect(text).toContain("0.05"); // distortion_strength
  });

  it("custom grain override — grain_amount 0.9 wins over super8 preset; other 3 remain preset", async () => {
    captureCreateBodies();
    const result = await createVintageLensImpl(makeCtx(), {
      parent_path: "/project1",
      name: "vintage_lens",
      source_top_path: "/project1/render1",
      era: "super8",
      grain_amount: 0.9,
    });

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    // Overridden grain.
    expect(text).toContain("0.9");
    // Super8 distortion still at 0.18.
    expect(text).toContain("0.18");
    // Super8 ca still at 0.012.
    expect(text).toContain("0.012");
  });

  it("missing source — impl returns errorResult when getNode throws for source_top_path", async () => {
    // Override the GET /api/nodes/:seg handler to return 404 for the source path.
    server.use(
      http.get(`${TD_BASE}/api/nodes/:seg`, ({ params }) => {
        const seg = decodeURIComponent(
          Array.isArray(params.seg) ? (params.seg[0] ?? "") : String(params.seg ?? ""),
        );
        if (seg.includes("missing_source")) {
          return HttpResponse.json(
            { ok: false, error: { message: "node not found" } },
            { status: 404 },
          );
        }
        return HttpResponse.json({
          ok: true,
          data: {
            path: seg,
            type: "noiseTOP",
            name: "noise1",
            parameters: {},
            inputs: [],
            outputs: [],
          },
        });
      }),
    );

    const result = await createVintageLensImpl(makeCtx(), {
      parent_path: "/project1",
      name: "vintage_lens",
      source_top_path: "/project1/missing_source",
      era: "super8",
    });

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("/project1/missing_source");
  });
});
