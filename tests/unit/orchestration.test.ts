import { describe, expect, it } from "vitest";
import type { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { finalize, NetworkBuilder } from "../../src/tools/layer2/orchestration.js";
import type { ToolContext } from "../../src/tools/types.js";

/**
 * Direct tests for {@link NetworkBuilder}'s fail-forward contract: connection,
 * parameter, Python, and layout failures must be *collected as warnings*, not
 * thrown, so a partial build still returns the nodes it managed to create. These
 * error branches are otherwise only exercised on the happy path by Layer 1 tools.
 */

interface FakeClientBehaviour {
  createNode?: () => Promise<{
    path: string;
    name: string;
    type: string;
    parameter_warnings?: string[];
  }>;
  updateNodeParameters?: () => Promise<unknown>;
  executePythonScript?: () => Promise<unknown>;
  connectNodes?: () => Promise<{ actual_input?: number }>;
}

function makeCtx(behaviour: FakeClientBehaviour): ToolContext {
  const client = {
    createNode:
      behaviour.createNode ??
      (async () => ({ path: "/project1/sys/op1", name: "op1", type: "noiseTOP" })),
    updateNodeParameters: behaviour.updateNodeParameters ?? (async () => ({})),
    executePythonScript: behaviour.executePythonScript ?? (async () => ({})),
    connectNodes: behaviour.connectNodes ?? (async () => ({ actual_input: 0 })),
  } as unknown as TouchDesignerClient;
  return { client } as unknown as ToolContext;
}

describe("NetworkBuilder fail-forward warnings", () => {
  it("collects a warning when a connection fails, without throwing", async () => {
    const builder = new NetworkBuilder(
      makeCtx({
        createNode: (() => {
          let n = 0;
          return async () => {
            n += 1;
            return { path: `/project1/sys/n${n}`, name: `n${n}`, type: "noiseTOP" };
          };
        })(),
        connectNodes: async () => {
          throw new Error("boom: cross-container wire rejected");
        },
      }),
      "/project1/sys",
    );
    const a = await builder.add("noiseTOP", "n1");
    const b = await builder.add("noiseTOP", "n2");

    await expect(builder.connect(a, b)).resolves.toBeUndefined();
    expect(builder.created).toHaveLength(2);
    expect(builder.warnings).toHaveLength(1);
    expect(builder.warnings[0]).toContain(`Failed to connect ${a} → ${b}`);
  });

  it("surfaces the bridge's parameter_warnings from add() so a typo'd token is not silent", async () => {
    // The bridge creates the node but reports params it could not apply (unknown
    // token / bad value). Regression guard: a recipe node.parameters typo (e.g. a
    // nonexistent displaceTOP token) must become a visible warning, not vanish.
    const builder = new NetworkBuilder(
      makeCtx({
        createNode: async () => ({
          path: "/project1/sys/displace",
          name: "displace",
          type: "displaceTOP",
          parameter_warnings: ["uvweightx", "uvweighty"],
        }),
      }),
      "/project1/sys",
    );
    await builder.add("displaceTOP", "displace", { uvweightx: 0.06, uvweighty: 0 });
    expect(builder.created).toHaveLength(1);
    expect(builder.warnings).toHaveLength(1);
    expect(builder.warnings[0]).toContain("displace");
    expect(builder.warnings[0]).toContain("uvweightx, uvweighty");
  });

  it("adds no warning when the bridge reports no parameter_warnings", async () => {
    const builder = new NetworkBuilder(makeCtx({}), "/project1/sys");
    await builder.add("noiseTOP", "n1", { period: 4 });
    expect(builder.warnings).toHaveLength(0);
  });

  it("collects a warning when setParams fails, without throwing", async () => {
    const builder = new NetworkBuilder(
      makeCtx({
        updateNodeParameters: async () => {
          throw new Error("param does not exist");
        },
      }),
      "/project1/sys",
    );
    await expect(builder.setParams("/project1/sys/op1", { foo: 1 })).resolves.toBeUndefined();
    expect(builder.warnings).toEqual([
      expect.stringContaining("Failed to set parameters on /project1/sys/op1"),
    ]);
  });

  it("collects a warning when a python step fails, without throwing", async () => {
    const builder = new NetworkBuilder(
      makeCtx({
        executePythonScript: async () => {
          throw new Error("SyntaxError");
        },
      }),
      "/project1/sys",
    );
    await expect(builder.python("op('x').par.foo = 1")).resolves.toBeUndefined();
    expect(builder.warnings).toEqual([expect.stringContaining("Python step failed")]);
  });

  it("collects a warning when auto-layout fails but still returns the built nodes", async () => {
    const builder = new NetworkBuilder(
      makeCtx({
        createNode: (() => {
          let n = 0;
          return async () => {
            n += 1;
            return { path: `/project1/sys/n${n}`, name: `n${n}`, type: "noiseTOP" };
          };
        })(),
        executePythonScript: async () => {
          throw new Error("layout exec failed");
        },
      }),
      "/project1/sys",
    );
    await builder.add("noiseTOP", "n1");
    await builder.add("noiseTOP", "n2");
    await expect(builder.layout()).resolves.toBeUndefined();
    expect(builder.created).toHaveLength(2);
    expect(builder.warnings).toEqual([expect.stringContaining("Auto-layout skipped")]);
  });
});

/**
 * finalize() runs the shared "expose controls → error-check → preview → respond"
 * step every Layer 1 tool funnels through. Its three degradation branches — a
 * failed control-panel exec, a failed error check, and a failed preview capture —
 * are fail-forward: each is folded into `warnings` while the build result stays
 * useful. These assert that contract directly.
 */

interface FinalizeClientBehaviour {
  executePythonScript?: () => Promise<{ stdout: string }>;
  getNetworkErrors?: () => Promise<{ errors: Array<{ path: string; message: string }> }>;
  getPreview?: () => Promise<{
    path: string;
    width: number;
    height: number;
    base64: string;
    format?: string;
  }>;
}

function makeFinalizeCtx(behaviour: FinalizeClientBehaviour): ToolContext {
  const client = {
    createNode: async () => ({ path: "/project1/sys/op1", name: "op1", type: "noiseTOP" }),
    updateNodeParameters: async () => ({}),
    connectNodes: async () => ({ actual_input: 0 }),
    // Default: perform-mode probe + panel/layout scripts succeed with empty report.
    executePythonScript:
      behaviour.executePythonScript ??
      (async () => ({ stdout: '{"created": [], "bound": [], "warnings": []}' })),
    getNetworkErrors: behaviour.getNetworkErrors ?? (async () => ({ errors: [] })),
    getPreview:
      behaviour.getPreview ??
      (async () => ({
        path: "/project1/sys/op1",
        width: 640,
        height: 360,
        base64: "AAAA",
        format: "png",
      })),
  } as unknown as TouchDesignerClient;
  return { client } as unknown as ToolContext;
}

/** Extracts the JSON `data` block finalize embeds in its text content. */
function parseFinalizeData(result: {
  content: Array<{ type: string; text?: string }>;
}): Record<string, unknown> {
  const text = result.content.find((c) => c.type === "text")?.text ?? "";
  const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  return JSON.parse(json);
}

describe("finalize degradation", () => {
  it("still succeeds with a 'Preview unavailable' warning when preview capture fails", async () => {
    const ctx = makeFinalizeCtx({
      getPreview: async () => {
        throw new Error("bridge offline: preview endpoint unreachable");
      },
    });
    const builder = new NetworkBuilder(ctx, "/project1/sys");

    const result = await finalize(ctx, {
      summary: "Built network",
      builder,
      outputPath: "/project1/sys/out",
    });

    // No thrown error, no image content — text-only useful result.
    expect(result.content.some((c) => c.type === "image")).toBe(false);
    const data = parseFinalizeData(result as { content: Array<{ type: string; text?: string }> });
    expect(data.container).toBe("/project1/sys");
    expect(data.warnings).toEqual([expect.stringContaining("Preview unavailable")]);
    expect(data.errors).toEqual([]);
  });

  it("still succeeds with an 'Error check unavailable' warning when the error check fails", async () => {
    const ctx = makeFinalizeCtx({
      getNetworkErrors: async () => {
        throw new Error("bridge offline: node_errors endpoint unreachable");
      },
    });
    const builder = new NetworkBuilder(ctx, "/project1/sys");

    const result = await finalize(ctx, {
      summary: "Built network",
      builder,
      // No outputPath → preview step skipped, isolating the error-check branch.
    });

    const data = parseFinalizeData(result as { content: Array<{ type: string; text?: string }> });
    expect(data.warnings).toEqual([expect.stringContaining("Error check unavailable")]);
    // Fail-forward: errors default to empty and the result is still returned.
    expect(data.errors).toEqual([]);
    expect(data.container).toBe("/project1/sys");
  });

  it("folds a control-panel exec failure into warnings without aborting the build", async () => {
    // exposeControls runs a panel script via executePythonScript; make it throw.
    const ctx = makeFinalizeCtx({
      executePythonScript: async () => {
        throw new Error("SyntaxError in generated panel script");
      },
      // Error-check + preview succeed, so any panel warning is the only degradation.
    });
    const builder = new NetworkBuilder(ctx, "/project1/sys");

    const result = await finalize(ctx, {
      summary: "Built network",
      builder,
      controls: [{ name: "Speed", type: "Float", bind_to: ["/project1/sys/op1"] }] as never,
    });

    const data = parseFinalizeData(result as { content: Array<{ type: string; text?: string }> });
    expect(data.warnings).toEqual([expect.stringContaining("Control panel skipped")]);
    // Fail-forward: an empty controls summary is still recorded, build still returns.
    expect(data.controls).toEqual({ added: [], bound: 0 });
    expect(data.container).toBe("/project1/sys");
  });
});
