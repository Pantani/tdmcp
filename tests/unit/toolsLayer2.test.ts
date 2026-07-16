import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { arrangeNetworkImpl, arrangeNetworkSchema } from "../../src/tools/layer2/arrangeNetwork.js";
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

  it("arrange_network applies annotation-aware plans without raw exec", async () => {
    let applyBody: Record<string, unknown> | undefined;
    server.use(
      http.post(`${TD_BASE}/api/editor/annotation-layout/context`, () =>
        HttpResponse.json({
          ok: true,
          data: {
            root_path: "/project1",
            recursive: false,
            fingerprint: "a".repeat(64),
            networks: [
              {
                path: "/project1",
                nodes: [
                  { path: "/project1/a", x: -20, y: 50, w: 100, h: 60 },
                  { path: "/project1/out", x: 700, y: 40, w: 100, h: 60 },
                ],
                annotations: [
                  {
                    path: "/project1/note",
                    x: -100,
                    y: 100,
                    w: 300,
                    h: 200,
                    enclosed_paths: ["/project1/a"],
                  },
                ],
                docked: [],
                edges: [{ from: "/project1/a", to: "/project1/out" }],
              },
            ],
          },
        }),
      ),
      http.post(`${TD_BASE}/api/editor/annotation-layout/apply`, async ({ request }) => {
        applyBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          ok: true,
          data: {
            applied: true,
            rolled_back: false,
            root_path: "/project1",
            fingerprint: "a".repeat(64),
            moved: 3,
            resized_annotations: 1,
            networks: 1,
            rollback_errors: [],
            undo_wrapper_label: "MCP arrange annotation-aware /project1",
          },
        });
      }),
    );

    const result = await arrangeNetworkImpl(makeCtx(), {
      path: "/project1",
      recursive: false,
      include_docked: true,
      annotation_aware: true,
      resize_annotations: true,
      annotation_padding: 80,
    });

    expect(result.isError).not.toBe(true);
    expect(textOf(result)).toContain("annotation-aware grouping");
    expect(applyBody).toMatchObject({
      root_path: "/project1",
      recursive: false,
      fingerprint: "a".repeat(64),
    });
    const networks = applyBody?.networks as Array<{
      positions: Record<string, [number, number]>;
      annotation_bounds: Record<string, { resized: boolean }>;
    }>;
    expect(networks[0]?.positions).toHaveProperty("/project1/a");
    expect(networks[0]?.positions).toHaveProperty("/project1/note");
    expect(networks[0]?.annotation_bounds["/project1/note"]?.resized).toBe(true);
  });

  it("arrange_network explicit uses one context read and one structured apply", async () => {
    let contextCalls = 0;
    let applyCalls = 0;
    let applyBody: Record<string, unknown> | undefined;
    const fingerprint = "a".repeat(64);
    server.use(
      http.post(`${TD_BASE}/api/editor/reposition/context`, async ({ request }) => {
        contextCalls += 1;
        const body = (await request.json()) as Record<string, unknown>;
        expect(body).toMatchObject({
          root_path: "/project1/show",
          target_source: "provided_paths",
          include_docked: true,
        });
        return HttpResponse.json({
          ok: true,
          data: {
            root_path: body.root_path,
            target_source: body.target_source,
            include_docked: body.include_docked,
            requested_paths: ["/project1/show/a"],
            nodes: [
              {
                path: "/project1/show/a",
                position: [0, 0],
                source: "explicit",
              },
            ],
            editor_context: null,
            fingerprint,
          },
        });
      }),
      http.post(`${TD_BASE}/api/editor/reposition`, async ({ request }) => {
        applyCalls += 1;
        applyBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          ok: true,
          data: {
            mode: "explicit",
            status: "applied",
            idempotency_key: applyBody.idempotency_key,
            root_path: "/project1/show",
            target_source: "provided_paths",
            fingerprint_before: fingerprint,
            fingerprint_after: "b".repeat(64),
            paths: [
              {
                path: "/project1/show/a",
                source: "explicit",
                requested: [100, -50],
                previous: [0, 0],
                final: [100, -50],
                status: "applied",
              },
            ],
            counts: { explicit: 1, docked_carried: 0, applied: 1, unchanged: 0, failed: 0 },
            rollback: { attempted: false, succeeded: true, errors: [] },
            warnings: [],
          },
        });
      }),
    );

    const result = await arrangeNetworkImpl(makeCtx(), {
      path: "/project1/show",
      layout_mode: "explicit",
      positions: { "/project1/show/a": [100, -50] },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ status: "applied" });
    expect(contextCalls).toBe(1);
    expect(applyCalls).toBe(1);
    expect(applyBody).toMatchObject({
      fingerprint,
      editor_context: null,
      positions: [{ path: "/project1/show/a", x: 100, y: -50 }],
    });
  });

  it("arrange_network explicit preserves bounded rollback details as an MCP error", async () => {
    const fingerprint = "a".repeat(64);
    server.use(
      http.post(`${TD_BASE}/api/editor/reposition/context`, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          ok: true,
          data: {
            root_path: body.root_path,
            target_source: body.target_source,
            include_docked: body.include_docked,
            requested_paths: ["/project1/show/a"],
            nodes: [{ path: "/project1/show/a", position: [0, 0], source: "explicit" }],
            editor_context: null,
            fingerprint,
          },
        });
      }),
      http.post(`${TD_BASE}/api/editor/reposition`, async ({ request }) => {
        const body = (await request.json()) as { idempotency_key: string };
        return HttpResponse.json(
          {
            ok: false,
            error: {
              code: "reposition_apply_failed",
              message: "placement failed and was restored",
              details: {
                mode: "explicit",
                status: "failed",
                idempotency_key: body.idempotency_key,
                root_path: "/project1/show",
                target_source: "provided_paths",
                paths: [
                  {
                    path: "/project1/show/a",
                    source: "explicit",
                    requested: [100, -50],
                    previous: [0, 0],
                    final: [0, 0],
                    status: "failed",
                    rollback: "restored",
                  },
                ],
                counts: {
                  explicit: 1,
                  docked_carried: 0,
                  applied: 0,
                  unchanged: 0,
                  failed: 1,
                },
                rollback: { attempted: true, succeeded: true, errors: [] },
                error: {
                  code: "reposition_apply_failed",
                  message: "placement failed and was restored",
                },
                warnings: [],
              },
            },
          },
          { status: 400 },
        );
      }),
    );

    const result = await arrangeNetworkImpl(makeCtx(), {
      path: "/project1/show",
      layout_mode: "explicit",
      positions: { "/project1/show/a": [100, -50] },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.error).toMatchObject({
      api_code: "reposition_apply_failed",
      details: { status: "failed", rollback: { succeeded: true } },
    });
  });

  it("arrange_network rejects explicit-only fields in automatic mode", () => {
    expect(
      arrangeNetworkSchema.safeParse({
        path: "/project1",
        positions: { "/project1/a": [0, 0] },
      }).success,
    ).toBe(false);
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
