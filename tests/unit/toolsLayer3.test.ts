import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { createTdNodeImpl } from "../../src/tools/layer3/createTdNode.js";
import { getTdInfoImpl } from "../../src/tools/layer3/getTdInfo.js";
import { getTdNodesImpl } from "../../src/tools/layer3/getTdNodes.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, offlineInfoHandler, TD_BASE } from "../helpers/tdMock.js";

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

describe("layer 3 tool handlers", () => {
  it("get_td_info reports connected with bridge info", async () => {
    const result = await getTdInfoImpl(makeCtx());
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("2023.12000");
  });

  it("get_td_info degrades gracefully (not an error) when offline", async () => {
    server.use(offlineInfoHandler);
    const result = await getTdInfoImpl(makeCtx());
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("not reachable");
  });

  it("create_td_node creates a node and warns on unknown type", async () => {
    const good = await createTdNodeImpl(makeCtx(), { parent_path: "/project1", type: "noiseTOP" });
    expect(textOf(good)).toContain("/project1/noisetop1");

    const bad = await createTdNodeImpl(makeCtx(), { parent_path: "/project1", type: "fooBarTOP" });
    expect(textOf(bad)).toContain("not found in the knowledge base");
  });

  it("create_td_node returns a friendly error when offline", async () => {
    server.use(http.post(`${TD_BASE}/api/nodes`, () => HttpResponse.error()));
    const result = await createTdNodeImpl(makeCtx(), {
      parent_path: "/project1",
      type: "noiseTOP",
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Cannot reach TouchDesigner");
  });

  it("get_td_nodes lists child nodes", async () => {
    const result = await getTdNodesImpl(makeCtx(), {
      parent_path: "/project1",
      path_only: false,
      detail_level: "summary",
    });
    const data = JSON.stringify(result.structuredContent);
    expect(data).toContain("noise1");
    expect(data).toContain("null1");
  });
});
