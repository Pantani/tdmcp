import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { execNodeMethodImpl } from "../../src/tools/layer3/execNodeMethod.js";
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

describe("execNodeMethodImpl", () => {
  it("calls the method and reports which node.method() ran", async () => {
    const result = await execNodeMethodImpl(makeCtx(), {
      path: "/project1/moviein1",
      method: "cook",
      args: [],
      kwargs: {},
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("/project1/moviein1.cook()");
  });

  it("forwards method name, positional args, and kwargs to the bridge", async () => {
    let captured: { method?: string; args?: unknown[]; kwargs?: Record<string, unknown> } = {};
    server.use(
      http.post(`${TD_BASE}/api/nodes/:seg/method`, async ({ request }) => {
        captured = (await request.json()) as typeof captured;
        return HttpResponse.json({ ok: true, data: { result: "done" } });
      }),
    );
    await execNodeMethodImpl(makeCtx(), {
      path: "/project1/geo1",
      method: "cook",
      args: [true],
      kwargs: { force: true },
    });
    expect(captured.method).toBe("cook");
    expect(captured.args).toEqual([true]);
    expect(captured.kwargs).toMatchObject({ force: true });
  });

  it("surfaces a bridge failure as an error result", async () => {
    server.use(
      http.post(`${TD_BASE}/api/nodes/:seg/method`, () =>
        HttpResponse.json({ ok: false, error: "AttributeError: no method 'frobnicate'" }),
      ),
    );
    const result = await execNodeMethodImpl(makeCtx(), {
      path: "/project1/x",
      method: "frobnicate",
      args: [],
      kwargs: {},
    });
    expect(result.isError).toBe(true);
  });
});
