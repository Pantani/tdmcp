import { describe, expect, it } from "vitest";
import type { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { NetworkBuilder } from "../../src/tools/layer2/orchestration.js";
import type { ToolContext } from "../../src/tools/types.js";

/**
 * Direct tests for {@link NetworkBuilder}'s fail-forward contract: connection,
 * parameter, Python, and layout failures must be *collected as warnings*, not
 * thrown, so a partial build still returns the nodes it managed to create. These
 * error branches are otherwise only exercised on the happy path by Layer 1 tools.
 */

interface FakeClientBehaviour {
  createNode?: () => Promise<{ path: string; name: string; type: string }>;
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
