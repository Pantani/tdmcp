import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { buildDocument, documentNetworkImpl } from "../../src/tools/layer3/documentNetwork.js";
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
    logger: silentLogger,
  } as unknown as ToolContext;
}

describe("buildDocument (pure)", () => {
  it("emits a Mermaid flowchart with node labels and edges", () => {
    const doc = buildDocument(
      "/project1",
      [
        { path: "/project1/noise1", type: "noiseTOP", name: "noise1" },
        { path: "/project1/blur1", type: "blurTOP", name: "blur1" },
      ],
      [{ source_path: "/project1/noise1", target_path: "/project1/blur1" }],
    );
    expect(doc.mermaid).toContain("flowchart LR");
    expect(doc.mermaid).toContain("noise1 (noiseTOP)");
    expect(doc.mermaid).toContain("blur1 (blurTOP)");
    // The connection becomes an arrow between the two generated ids.
    expect(doc.mermaid).toMatch(/n0 --> n1/);
  });

  it("counts nodes by operator family and type", () => {
    const doc = buildDocument(
      "/p",
      [
        { path: "/p/a", type: "noiseTOP", name: "a" },
        { path: "/p/b", type: "blurTOP", name: "b" },
        { path: "/p/c", type: "audiodeviceinCHOP", name: "c" },
      ],
      [],
    );
    expect(doc.families).toMatchObject({ TOP: 2, CHOP: 1 });
    expect(doc.nodeCount).toBe(3);
    expect(doc.connectionCount).toBe(0);
    expect(doc.top_types).toContain("noiseTOP×1");
  });

  it("truncates the diagram past the node cap but counts every node", () => {
    const nodes = Array.from({ length: 200 }, (_, i) => ({
      path: `/p/n${i}`,
      type: "noiseTOP",
      name: `n${i}`,
    }));
    const doc = buildDocument("/p", nodes, []);
    expect(doc.truncated).toBe(true);
    // Family counts cover all 200, even though only 150 are drawn.
    expect(doc.nodeCount).toBe(200);
    expect(doc.families.TOP).toBe(200);
  });
});

describe("documentNetworkImpl", () => {
  it("documents the live topology returned by the bridge", async () => {
    const result: CallToolResult = await documentNetworkImpl(makeCtx(), {
      path: "/project1",
      recursive: false,
    });
    expect(result.isError).toBeFalsy();
    const data = (result as { structuredContent?: { nodeCount: number; mermaid: string } })
      .structuredContent;
    // The mock topology contains a single noise1 node.
    expect(data?.nodeCount).toBe(1);
    expect(data?.mermaid).toContain("flowchart LR");
  });
});
