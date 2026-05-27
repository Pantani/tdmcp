import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { executePythonScriptImpl } from "../../src/tools/layer3/executePythonScript.js";
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

describe("executePythonScriptImpl", () => {
  it("runs the script and reports success", async () => {
    const result = await executePythonScriptImpl(makeCtx(), {
      script: "print('hi')",
      return_output: true,
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("Python executed in TouchDesigner.");
  });

  it("forwards the script and return_output flag to the bridge and echoes the result", async () => {
    let captured: { script?: string; return_output?: boolean } = {};
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        captured = (await request.json()) as typeof captured;
        return HttpResponse.json({ ok: true, data: { result: 42, stdout: "out" } });
      }),
    );
    const result = await executePythonScriptImpl(makeCtx(), {
      script: "1+1",
      return_output: false,
    });
    expect(captured.script).toBe("1+1");
    expect(captured.return_output).toBe(false);
    // The structured result payload is echoed in the JSON fence.
    expect(textOf(result)).toContain("42");
  });

  it("surfaces a bridge failure as an error result instead of throwing", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        HttpResponse.json({ ok: false, error: "NameError: name 'foo' is not defined" }),
      ),
    );
    const result = await executePythonScriptImpl(makeCtx(), {
      script: "foo",
      return_output: true,
    });
    expect(result.isError).toBe(true);
  });
});
