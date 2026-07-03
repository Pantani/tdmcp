import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { arrangeNetworkImpl } from "../../src/tools/layer2/arrangeNetwork.js";
import { connectNodesImpl } from "../../src/tools/layer2/connectNodes.js";
import { createContainerImpl } from "../../src/tools/layer2/createContainer.js";
import { createGlslShaderImpl } from "../../src/tools/layer2/createGlslShader.js";
import { createNodeChainImpl } from "../../src/tools/layer2/createNodeChain.js";
import { createPythonScriptImpl } from "../../src/tools/layer2/createPythonScript.js";
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

  it("create_glsl_shader binds numeric uniforms via the Vectors sequence, not the legacy flat params", async () => {
    const scripts: string[] = [];
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        scripts.push(((await request.json()) as { script: string }).script);
        return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
      }),
    );
    const result = await createGlslShaderImpl(makeCtx(), {
      parent_path: "/project1",
      name: "glsl1",
      fragment_shader:
        "out vec4 fragColor; uniform vec3 uColor; void main(){ fragColor = vec4(uColor,1.0); }",
      uniforms: [
        { name: "uColor", type: "vec3", default_value: "0.2,0.4,0.8" },
        { name: "uTex", type: "sampler2D" },
      ],
      resolution: "input",
    });
    const bind = scripts.find((s) => s.includes("seq.vec.numBlocks"));
    expect(bind).toBeDefined();
    // Real GLSL TOP uniform params: vec<i>name + vec<i>value{x,y,z,w} (all components).
    expect(bind).toContain("vec%dname");
    expect(bind).toContain("vec%dvalue%s");
    expect(bind).toContain('"name":"uColor"');
    expect(bind).toContain("0.2");
    expect(bind).toContain("0.8");
    // The flat params the old path used don't exist on a GLSL TOP — must be gone.
    expect(scripts.join("\n")).not.toContain("uniname");
    expect(scripts.join("\n")).not.toContain("value0x");
    // sampler2D can't be auto-bound to a numeric value → surfaced as a warning.
    expect(textOf(result)).toContain("uTex");
    expect(textOf(result)).toContain("manually");
  });

  it("create_container creates a COMP", async () => {
    const result = await createContainerImpl(makeCtx(), {
      parent_path: "/project1",
      name: "viz",
      comp_type: "container",
    });
    expect(textOf(result)).toContain("/project1/viz");
  });

  it("arrange_network positions a network's nodes via exec", async () => {
    let execScript = "";
    server.use(
      http.get(`${TD_BASE}/api/network/:seg/topology`, () =>
        HttpResponse.json({
          ok: true,
          data: {
            nodes: [
              { path: "/project1/a", type: "noiseTOP", name: "a" },
              { path: "/project1/b", type: "levelTOP", name: "b" },
            ],
            connections: [
              {
                source_path: "/project1/a",
                source_output: 0,
                target_path: "/project1/b",
                target_input: 0,
              },
            ],
          },
        }),
      ),
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        execScript = ((await request.json()) as { script: string }).script;
        return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
      }),
    );
    const result = await arrangeNetworkImpl(makeCtx(), {
      path: "/project1",
      recursive: false,
      include_docked: true,
    });
    expect(textOf(result)).toContain("Arranged 2 node(s)");
    // Downstream node "b" is pushed right of source "a".
    expect(execScript).toContain("_n.nodeX = _xy[0]");
    expect(execScript).toContain('"/project1/a":[0,0]');
    expect(execScript).toContain('"/project1/b":[200,0]');
  });

  it("create_python_script writes a text DAT's code to its own .text", async () => {
    let execScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        execScript = ((await request.json()) as { script: string }).script;
        return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
      }),
    );
    const result = await createPythonScriptImpl(makeCtx(), {
      parent_path: "/project1",
      name: "txt1",
      code: "print('hi')",
      dat_type: "text",
    });
    expect(textOf(result)).toContain("/project1/txt1");
    expect(execScript).toBe('op("/project1/txt1").text = "print(\'hi\')"');
  });

  it("create_python_script writes a script DAT's code to its callbacks DAT, not its read-only .text", async () => {
    let execScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        execScript = ((await request.json()) as { script: string }).script;
        return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
      }),
    );
    const result = await createPythonScriptImpl(makeCtx(), {
      parent_path: "/project1",
      name: "builder",
      code: "def onCook(dat): pass",
      dat_type: "script",
    });
    expect(textOf(result)).toContain("/project1/builder");
    // Resolves the callbacks DAT via the script DAT's `callbacks` parameter,
    // with a fallback to the `<name>_callbacks` sibling.
    expect(execScript).toContain('_op = op("/project1/builder")');
    expect(execScript).toContain("_op.par.callbacks.eval()");
    expect(execScript).toContain("_op.name + '_callbacks'");
    expect(execScript).toContain('_cb.text = "def onCook(dat): pass"');
    // Must NOT assign to the scriptDAT's own read-only .text.
    expect(execScript).not.toContain('op("/project1/builder").text =');
  });

  it("arrange_network reports when there is nothing to arrange", async () => {
    server.use(
      http.get(`${TD_BASE}/api/network/:seg/topology`, () =>
        HttpResponse.json({ ok: true, data: { nodes: [], connections: [] } }),
      ),
    );
    const result = await arrangeNetworkImpl(makeCtx(), {
      path: "/empty",
      recursive: false,
      include_docked: true,
    });
    expect(textOf(result)).toContain("No nodes to arrange");
  });
});
