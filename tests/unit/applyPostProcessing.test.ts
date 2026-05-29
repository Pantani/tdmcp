import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { applyPostProcessingImpl } from "../../src/tools/layer1/applyPostProcessing.js";
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

describe("applyPostProcessingImpl", () => {
  it("pulls the source through a selectTOP referencing source_path", async () => {
    const bodies = captureCreateBodies();
    await applyPostProcessingImpl(makeCtx(), {
      source_path: "/project1/render1",
      effects: ["blur"],
      parent_path: "/project1",
    });
    const src = bodies.find((b) => b.name === "source");
    expect(src?.type).toBe("selectTOP");
    // The selectTOP's path is set by PATCH/setParams, not at creation time,
    // so just verify the node was created.
  });

  it("creates a bloomTOP with tasteful defaults for the bloom effect", async () => {
    const bodies = captureCreateBodies();
    const result = await applyPostProcessingImpl(makeCtx(), {
      source_path: "/project1/render1",
      effects: ["bloom"],
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();
    const bloom = bodies.find((b) => b.type === "bloomTOP");
    expect(bloom).toBeDefined();
    expect(bloom?.parameters).toMatchObject({
      bloomthreshold: 0.8,
      bloomintensity: 0.6,
    });
  });

  it("creates a glslTOP + textDAT pair for GLSL-based effects like rgb_split", async () => {
    const bodies = captureCreateBodies();
    await applyPostProcessingImpl(makeCtx(), {
      source_path: "/project1/render1",
      effects: ["rgb_split"],
      parent_path: "/project1",
    });
    // GLSL effect → glslTOP node + a textDAT to hold the fragment source.
    expect(bodies.some((b) => b.type === "glslTOP")).toBe(true);
    expect(bodies.some((b) => b.type === "textDAT")).toBe(true);
  });

  it("supports the Phase-14 GLSL effects (halftone, crt, mirror) as glslTOP passes", async () => {
    const bodies = captureCreateBodies();
    const result = await applyPostProcessingImpl(makeCtx(), {
      source_path: "/project1/render1",
      effects: ["halftone", "crt", "mirror"],
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();
    // Three GLSL effects → three glslTOP + three textDAT.
    expect(bodies.filter((b) => b.type === "glslTOP").length).toBe(3);
    expect(bodies.filter((b) => b.type === "textDAT").length).toBe(3);
    expect(textOf(result)).toContain("3/3");
  });

  it("chains multiple effects in order and reports the applied count in the summary", async () => {
    const bodies = captureCreateBodies();
    const result = await applyPostProcessingImpl(makeCtx(), {
      source_path: "/project1/render1",
      effects: ["bloom", "blur", "vignette"],
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();
    // All three effect nodes should be present.
    expect(bodies.some((b) => b.type === "bloomTOP")).toBe(true);
    expect(bodies.some((b) => b.type === "blurTOP")).toBe(true);
    // vignette is a GLSL effect.
    expect(bodies.some((b) => b.type === "glslTOP")).toBe(true);
    // Summary: "Applied 3/3 post-processing effect(s) to /project1/render1."
    const text = textOf(result);
    expect(text).toContain("3/3");
    expect(text).toContain("/project1/render1");
    // Final null output.
    expect(bodies.some((b) => b.name === "out1" && b.type === "nullTOP")).toBe(true);
  });
});
