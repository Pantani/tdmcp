import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { connectNodesViaBridge } from "../../src/tools/layer2/connectHelper.js";
import { connectNodesImpl } from "../../src/tools/layer2/connectNodes.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

const server = makeTdServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function makeClient(): TouchDesignerClient {
  return new TouchDesignerClient({ baseUrl: TD_BASE, timeoutMs: 2000 });
}

function makeCtx(): ToolContext {
  return {
    client: makeClient(),
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

/**
 * `/api/batch` resolves (HTTP 200) but reports the connect op failed inside the
 * batch — the case the helper used to swallow before falling through to Python.
 */
function batchReportsConnectFailure(error?: string) {
  return http.post(`${TD_BASE}/api/batch`, () =>
    HttpResponse.json({
      ok: true,
      data: { results: [{ action: "connect", ok: false, ...(error ? { error } : {}) }] },
    }),
  );
}

describe("connect endpoint fallback chain", () => {
  it("happy path: a clean batch connect reports method 'batch' and no batchError", async () => {
    const result = await connectNodesViaBridge(makeClient(), "/project1/a", "/project1/b");
    expect(result.method).toBe("batch");
    expect(result.batchError).toBeUndefined();
  });

  it("captures the batch op error on the recovered ConnectResult", async () => {
    server.use(batchReportsConnectFailure("connect op not supported by batch"));
    const result = await connectNodesViaBridge(makeClient(), "/project1/a", "/project1/b");
    expect(result.method).toBe("python");
    expect(result.batchError).toBe("connect op not supported by batch");
  });

  it("connect_nodes mentions the batch error in its output when Python recovers", async () => {
    server.use(batchReportsConnectFailure("cannot wire across containers"));
    const result = await connectNodesImpl(makeCtx(), {
      source_path: "/project1/a",
      target_path: "/project1/b",
      source_output: 0,
      target_input: 0,
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("via python");
    expect(text).toContain("cannot wire across containers");
  });

  it("folds the batch error into the thrown message when the Python fallback also fails", async () => {
    server.use(
      batchReportsConnectFailure("batch connect rejected"),
      http.post(`${TD_BASE}/api/exec`, () =>
        HttpResponse.json({ ok: false, error: { message: "python connect raised" } }),
      ),
    );
    const result = await connectNodesImpl(makeCtx(), {
      source_path: "/project1/a",
      target_path: "/project1/b",
      source_output: 0,
      target_input: 0,
    });
    expect(result.isError).toBe(true);
    const text = textOf(result);
    // Both the Python error and the discarded batch reason are surfaced.
    expect(text).toContain("python connect raised");
    expect(text).toContain("batch connect rejected");
  });

  it("does not invent a batchError when the batch op fails without an error string", async () => {
    server.use(batchReportsConnectFailure(undefined));
    const result = await connectNodesViaBridge(makeClient(), "/project1/a", "/project1/b");
    expect(result.method).toBe("python");
    expect(result.batchError).toBeUndefined();
  });
});
