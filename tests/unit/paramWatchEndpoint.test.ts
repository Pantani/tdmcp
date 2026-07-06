import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { parseParamChangedEvent } from "../../src/td-client/eventStream.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { TdApiError, TdConnectionError, TdTimeoutError } from "../../src/td-client/types.js";
import { watchParameterChangesImpl } from "../../src/tools/layer3/watchParameterChanges.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

// ---------------------------------------------------------------------------
// param_watch_endpoint
//
// The opt-in POST/DELETE/GET /api/params/watch routes (survive ALLOW_EXEC=0) +
// the `param.changed` event on the existing WebSocket stream. Pins:
//   1. request/response SHAPES for watch/unwatch/list;
//   2. every TdError mapping (404 → friendly upgrade message, 400 → TdApiError,
//      connection refusal → TdConnectionError, timeout → TdTimeoutError);
//   3. the parseParamChangedEvent validator on the event stream;
//   4. the Layer-3 tool surfacing the validated shape + friendly errors.
// ---------------------------------------------------------------------------

const server = makeTdServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function makeClient(overrides?: { timeoutMs?: number; baseUrl?: string }): TouchDesignerClient {
  return new TouchDesignerClient({
    baseUrl: overrides?.baseUrl ?? TD_BASE,
    timeoutMs: overrides?.timeoutMs ?? 2000,
    logger: silentLogger,
  });
}

function makeCtx(client: TouchDesignerClient): ToolContext {
  return {
    client,
    knowledge: new KnowledgeBase(),
    recipes: new RecipeLibrary(),
    logger: silentLogger,
  };
}

const ok = (data: unknown) => HttpResponse.json({ ok: true, data });

describe("watchParameters client method", () => {
  it("registers a watch and returns the validated shape", async () => {
    let captured: unknown;
    server.use(
      http.post(`${TD_BASE}/api/params/watch`, async ({ request }) => {
        captured = await request.json();
        return ok({ path: "/project1/level1", pars: ["opacity"], watching: true });
      }),
    );
    const result = await makeClient().watchParameters("/project1/level1", { pars: ["opacity"] });
    expect(result).toEqual({ path: "/project1/level1", pars: ["opacity"], watching: true });
    expect(captured).toEqual({ path: "/project1/level1", pars: ["opacity"] });
  });

  it("sends pars:null for a watch-all subscription", async () => {
    let captured: unknown;
    server.use(
      http.post(`${TD_BASE}/api/params/watch`, async ({ request }) => {
        captured = await request.json();
        return ok({ path: "/project1/n", pars: null, watching: true });
      }),
    );
    const result = await makeClient().watchParameters("/project1/n");
    expect(result.pars).toBeNull();
    expect(captured).toEqual({ path: "/project1/n", pars: null });
  });

  it("unregisters a watch via DELETE", async () => {
    let method: string | undefined;
    server.use(
      http.delete(`${TD_BASE}/api/params/watch`, ({ request }) => {
        method = request.method;
        return ok({ path: "/project1/level1", pars: null, watching: false });
      }),
    );
    const result = await makeClient().unwatchParameters("/project1/level1");
    expect(method).toBe("DELETE");
    expect(result.watching).toBe(false);
  });

  it("lists active watches", async () => {
    server.use(
      http.get(`${TD_BASE}/api/params/watch`, () =>
        ok({ watches: [{ path: "/project1/level1", pars: ["opacity"] }], count: 1 }),
      ),
    );
    const result = await makeClient().listParameterWatches();
    expect(result.count).toBe(1);
    expect(result.watches[0]).toEqual({ path: "/project1/level1", pars: ["opacity"] });
  });

  it("maps a 404 (older bridge) to a friendly upgrade TdApiError", async () => {
    // The default tdMock 404s this route, matching an older bridge.
    const client = makeClient();
    await expect(client.watchParameters("/project1/level1")).rejects.toMatchObject({
      status: 404,
    });
    await expect(client.watchParameters("/project1/level1")).rejects.toThrow(/reinstall|update/i);
  });

  it("maps a 400 to TdApiError", async () => {
    server.use(
      http.post(`${TD_BASE}/api/params/watch`, () =>
        HttpResponse.json(
          { ok: false, error: { message: "operator not found: /project1/ghost" } },
          { status: 400 },
        ),
      ),
    );
    await expect(makeClient().watchParameters("/project1/ghost")).rejects.toBeInstanceOf(
      TdApiError,
    );
  });

  it("maps a connection refusal to TdConnectionError", async () => {
    server.use(
      http.post(`${TD_BASE}/api/params/watch`, () => HttpResponse.error()),
    );
    await expect(makeClient().watchParameters("/project1/n")).rejects.toBeInstanceOf(
      TdConnectionError,
    );
  });

  it("maps a hung request to TdTimeoutError", async () => {
    server.use(
      http.post(`${TD_BASE}/api/params/watch`, async () => {
        await new Promise((r) => setTimeout(r, 200));
        return ok({ path: "/project1/n", pars: null, watching: true });
      }),
    );
    await expect(
      makeClient({ timeoutMs: 20 }).watchParameters("/project1/n"),
    ).rejects.toBeInstanceOf(TdTimeoutError);
  });
});

describe("parseParamChangedEvent", () => {
  it("validates a well-formed param.changed payload", () => {
    const out = parseParamChangedEvent({
      event: "param.changed",
      data: { path: "/project1/level1", par: "opacity", prev: 0, value: 0.5, frame: 42 },
    });
    expect(out).toEqual({
      path: "/project1/level1",
      par: "opacity",
      prev: 0,
      value: 0.5,
      frame: 42,
    });
  });

  it("returns undefined for a different event type", () => {
    expect(parseParamChangedEvent({ event: "node.created", data: {} })).toBeUndefined();
  });

  it("returns undefined for a malformed payload", () => {
    expect(
      parseParamChangedEvent({ event: "param.changed", data: { path: 5, par: "x" } }),
    ).toBeUndefined();
  });

  it("accepts a null frame and string values", () => {
    const out = parseParamChangedEvent({
      event: "param.changed",
      data: { path: "/p/n", par: "file", prev: null, value: "clip.mov", frame: null },
    });
    expect(out).toEqual({ path: "/p/n", par: "file", prev: null, value: "clip.mov", frame: null });
  });
});

describe("watch_parameter_changes tool", () => {
  it("watch action returns the validated structured content", async () => {
    server.use(
      http.post(`${TD_BASE}/api/params/watch`, () =>
        ok({ path: "/project1/level1", pars: ["opacity"], watching: true }),
      ),
    );
    const result = await watchParameterChangesImpl(makeCtx(makeClient()), {
      path: "/project1/level1",
      parameters: ["opacity"],
      action: "watch",
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      action: "watch",
      path: "/project1/level1",
      parameters: ["opacity"],
      watching: true,
    });
  });

  it("list action reports every watch", async () => {
    server.use(
      http.get(`${TD_BASE}/api/params/watch`, () =>
        ok({ watches: [{ path: "/project1/a", pars: null }], count: 1 }),
      ),
    );
    const result = await watchParameterChangesImpl(makeCtx(makeClient()), {
      path: "unused-for-list",
      action: "list",
    });
    expect(result.structuredContent).toMatchObject({
      action: "list",
      count: 1,
      watches: [{ path: "/project1/a", parameters: null }],
    });
  });

  it("surfaces the friendly 404 upgrade message as an isError result (no throw)", async () => {
    // Default tdMock 404s the route -> friendly upgrade error, turned into isError.
    const result = await watchParameterChangesImpl(makeCtx(makeClient()), {
      path: "/project1/level1",
      action: "watch",
    });
    expect(result.isError).toBe(true);
    const text = result.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    expect(text).toMatch(/reinstall|update/i);
  });
});
