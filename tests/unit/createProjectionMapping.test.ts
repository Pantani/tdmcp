import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { createProjectionMappingImpl } from "../../src/tools/layer1/createProjectionMapping.js";
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

describe("create_projection_mapping", () => {
  it("wraps a demo grid source in a Corner Pin warp → Null when no source is given", async () => {
    const bodies = captureCreateBodies();
    const result = await createProjectionMappingImpl(makeCtx(), { parent_path: "/project1" });
    expect(result.isError).toBeFalsy();

    // Fallback reference source is a radial ramp so the warp handles are visible.
    const source = bodies.find((b) => b.name === "source");
    expect(source?.type).toBe("rampTOP");
    expect(source?.parameters).toMatchObject({ type: "radial" });

    const warp = bodies.find((b) => b.name === "warp");
    expect(warp?.type).toBe("cornerpinTOP");
    expect(warp?.parameters).toMatchObject({ extend: "hold" });
    expect(bodies.some((b) => b.name === "out1" && b.type === "nullTOP")).toBe(true);
    expect(result.content.some((c) => c.type === "image")).toBe(true);
    expect(textOf(result)).toContain("Corner Pin");
  });

  it("pulls a real source through a Select TOP into the Corner Pin", async () => {
    const bodies = captureCreateBodies();
    await createProjectionMappingImpl(makeCtx(), {
      source_path: "/project1/render1",
      parent_path: "/project1",
    });
    const source = bodies.find((b) => b.name === "source");
    expect(source?.type).toBe("selectTOP");
    expect(source?.parameters).toMatchObject({ top: "/project1/render1" });
    // No demo ramp when a real source is supplied.
    expect(bodies.some((b) => b.type === "rampTOP")).toBe(false);
    expect(bodies.some((b) => b.name === "warp" && b.type === "cornerpinTOP")).toBe(true);
  });
});
