import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { focusNetworkEditorImpl } from "../../src/tools/layer2/focusNetworkEditor.js";
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

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

describe("focusNetworkEditorImpl", () => {
  it("frames the given operators and reports the pane", async () => {
    const result = await focusNetworkEditorImpl(makeCtx(), {
      paths: ["/project1/noise1", "/project1/blur1"],
      animate: true,
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("Framed 2 operator(s)");
    expect(textOf(result)).toContain("pane1");
  });

  it("returns a friendly error when TouchDesigner is offline", async () => {
    server.use(http.post(`${TD_BASE}/api/editor/focus`, () => HttpResponse.error()));
    const result = await focusNetworkEditorImpl(makeCtx(), {
      paths: ["/project1/noise1"],
      animate: false,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Cannot reach TouchDesigner");
  });
});
