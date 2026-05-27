import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { getTdNodeErrorsImpl } from "../../src/tools/layer3/getTdNodeErrors.js";
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

interface ErrData {
  path: string;
  total: number;
  errors?: Array<{ path: string; message: string; type?: string }>;
  by_type?: Record<string, number>;
}

function sc(result: CallToolResult): ErrData {
  return (result as { structuredContent?: ErrData }).structuredContent as ErrData;
}

describe("getTdNodeErrorsImpl", () => {
  it("reports a clean node with zero errors", async () => {
    const result = await getTdNodeErrorsImpl(makeCtx(), {
      path: "/project1/noise1",
      recursive: false,
      summary: false,
    });
    expect(result.isError).toBeFalsy();
    expect(sc(result).total).toBe(0);
  });

  it("returns the full error list when errors are present", async () => {
    server.use(
      http.get(`${TD_BASE}/api/nodes/:seg/errors`, () =>
        HttpResponse.json({
          ok: true,
          data: {
            errors: [
              { path: "/project1/glsl1", message: "compile failed", type: "error" },
              { path: "/project1/glsl1", message: "deprecated par", type: "warning" },
            ],
          },
        }),
      ),
    );
    const result = await getTdNodeErrorsImpl(makeCtx(), {
      path: "/project1/glsl1",
      recursive: false,
      summary: false,
    });
    const data = sc(result);
    expect(data.total).toBe(2);
    expect(data.errors).toHaveLength(2);
  });

  it("groups counts by type when summary is requested (and omits the full list)", async () => {
    server.use(
      http.get(`${TD_BASE}/api/nodes/:seg/errors`, () =>
        HttpResponse.json({
          ok: true,
          data: {
            errors: [
              { path: "/a", message: "x", type: "error" },
              { path: "/a", message: "y", type: "error" },
              { path: "/a", message: "z", type: "warning" },
            ],
          },
        }),
      ),
    );
    const result = await getTdNodeErrorsImpl(makeCtx(), {
      path: "/a",
      recursive: false,
      summary: true,
    });
    const data = sc(result);
    expect(data.total).toBe(3);
    expect(data.by_type).toMatchObject({ error: 2, warning: 1 });
    expect(data.errors).toBeUndefined();
  });

  it("hits the network endpoint when recursive is true", async () => {
    let networkHit = false;
    server.use(
      http.get(`${TD_BASE}/api/network/:seg/errors`, () => {
        networkHit = true;
        return HttpResponse.json({ ok: true, data: { errors: [] } });
      }),
    );
    await getTdNodeErrorsImpl(makeCtx(), {
      path: "/project1",
      recursive: true,
      summary: false,
    });
    expect(networkHit).toBe(true);
  });
});
