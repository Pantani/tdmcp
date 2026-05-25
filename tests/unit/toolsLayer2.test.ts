import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { connectNodesImpl } from "../../src/tools/layer2/connectNodes.js";
import { createContainerImpl } from "../../src/tools/layer2/createContainer.js";
import { createGlslShaderImpl } from "../../src/tools/layer2/createGlslShader.js";
import { createNodeChainImpl } from "../../src/tools/layer2/createNodeChain.js";
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

describe("layer 2 tool handlers", () => {
  it("create_node_chain creates nodes and connects them sequentially", async () => {
    const result = await createNodeChainImpl(makeCtx(), {
      parent_path: "/project1",
      nodes: [
        { type: "noiseTOP", name: "noise1" },
        { type: "nullTOP", name: "null1" },
      ],
      connect_sequentially: true,
    });
    const text = textOf(result);
    expect(text).toContain("Created 2 node(s) and 1 connection(s)");
    expect(text).toContain("/project1/noise1");
    expect(text).toContain("/project1/null1");
  });

  it("create_node_chain reports partial progress on failure without deleting", async () => {
    let calls = 0;
    server.use(
      http.post(`${TD_BASE}/api/nodes`, async ({ request }) => {
        calls++;
        if (calls === 2) return HttpResponse.error();
        const body = (await request.json()) as { parent_path: string; type: string; name?: string };
        return HttpResponse.json({
          ok: true,
          data: { path: `${body.parent_path}/${body.name}`, type: body.type, name: body.name },
        });
      }),
    );
    const result = await createNodeChainImpl(makeCtx(), {
      parent_path: "/project1",
      nodes: [
        { type: "noiseTOP", name: "a" },
        { type: "nullTOP", name: "b" },
      ],
      connect_sequentially: true,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Stopped after creating 1/2");
    expect(textOf(result)).toContain("No nodes were deleted");
  });

  it("connect_nodes uses the batch endpoint", async () => {
    const result = await connectNodesImpl(makeCtx(), {
      source_path: "/project1/noise1",
      target_path: "/project1/null1",
      source_output: 0,
      target_input: 0,
    });
    expect(textOf(result)).toContain("via batch");
  });

  it("connect_nodes falls back to Python when batch reports failure", async () => {
    server.use(
      http.post(`${TD_BASE}/api/batch`, () =>
        HttpResponse.json({
          ok: true,
          data: { results: [{ action: "connect", ok: false, error: "no batch" }] },
        }),
      ),
    );
    const result = await connectNodesImpl(makeCtx(), {
      source_path: "/project1/a",
      target_path: "/project1/b",
      source_output: 0,
      target_input: 0,
    });
    expect(textOf(result)).toContain("via python");
  });

  it("create_glsl_shader creates a GLSL TOP and its fragment DAT", async () => {
    const result = await createGlslShaderImpl(makeCtx(), {
      parent_path: "/project1",
      name: "glsl1",
      fragment_shader: "out vec4 fragColor; void main(){ fragColor = vec4(1.0); }",
      resolution: "input",
    });
    const text = textOf(result);
    expect(text).toContain("/project1/glsl1");
    expect(text).toContain("glsl1_frag");
  });

  it("create_container creates a COMP", async () => {
    const result = await createContainerImpl(makeCtx(), {
      parent_path: "/project1",
      name: "viz",
      comp_type: "container",
    });
    expect(textOf(result)).toContain("/project1/viz");
  });
});
