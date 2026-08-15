import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { setParametersBatchImpl } from "../../src/tools/layer2/setParametersBatch.js";
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

describe("set_parameters_batch", () => {
  it("rejects executable targets before submitting any batch mutation in raw-off mode", async () => {
    let batchCalls = 0;
    server.use(
      http.get(`${TD_BASE}/api/nodes/:seg`, ({ params }) =>
        HttpResponse.json({
          ok: true,
          data: {
            path: decodeURIComponent(String(params.seg)),
            type: "executeDAT",
            name: "execute1",
            parameters: {},
          },
        }),
      ),
      http.post(`${TD_BASE}/api/batch`, () => {
        batchCalls++;
        return HttpResponse.json({ ok: true, data: { results: [] } });
      }),
    );
    const result = await setParametersBatchImpl(
      { ...makeCtx(), allowRawPython: false },
      { updates: [{ path: "/project1/execute1", parameters: { active: true } }] },
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("raw Python is disabled");
    expect(batchCalls).toBe(0);
  });

  it("permits safe constant batch updates in raw-off mode", async () => {
    const result = await setParametersBatchImpl(
      { ...makeCtx(), allowRawPython: false },
      { updates: [{ path: "/project1/noise1", parameters: { period: 4 } }] },
    );
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("Applied 1 parameter update(s)");
  });

  it("reports all N updates applied when every result is ok", async () => {
    const result = await setParametersBatchImpl(makeCtx(), {
      updates: [
        { path: "/project1/noise1", parameters: { period: 4 } },
        { path: "/project1/blur1", parameters: { size: 2 } },
      ],
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    // "Applied 2 parameter update(s) in one batch."
    expect(text).toMatch(/applied 2 parameter update\(s\)/i);
    expect(text).not.toContain("failed");
  });

  it("reports partial failure when some results are not ok", async () => {
    server.use(
      http.post(`${TD_BASE}/api/batch`, () =>
        HttpResponse.json({
          ok: true,
          data: {
            results: [
              { action: "update", ok: true },
              { action: "update", ok: false, error: "node not found" },
            ],
          },
        }),
      ),
    );
    const result = await setParametersBatchImpl(makeCtx(), {
      updates: [
        { path: "/project1/noise1", parameters: { period: 4 } },
        { path: "/project1/missing", parameters: { period: 1 } },
      ],
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    // "Applied 1/2 parameter update(s); 1 failed (see results)."
    expect(text).toMatch(/1\/2/);
    expect(text).toContain("failed");
  });

  it("forwards all updates as batch operations in one request", async () => {
    const captured: unknown[] = [];
    server.use(
      http.post(`${TD_BASE}/api/batch`, async ({ request }) => {
        const body = (await request.json()) as { operations: unknown[] };
        captured.push(...body.operations);
        return HttpResponse.json({
          ok: true,
          data: { results: body.operations.map(() => ({ action: "update", ok: true })) },
        });
      }),
    );
    await setParametersBatchImpl(makeCtx(), {
      updates: [
        { path: "/a", parameters: { tx: 1 } },
        { path: "/b", parameters: { ty: 2 } },
        { path: "/c", parameters: { tz: 3 } },
      ],
    });
    expect(captured).toHaveLength(3);
    expect(captured).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "update", path: "/a" }),
        expect.objectContaining({ action: "update", path: "/b" }),
        expect.objectContaining({ action: "update", path: "/c" }),
      ]),
    );
  });
});
