import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectRssFeedBusImpl,
  connectRssFeedBusSchema,
} from "../../src/tools/layer2/connectRssFeedBus.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectRssFeedBusImpl", () => {
  it("builds an RSS feed bus scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "rss_feed_bus",
          container_path: "/project1/rss_feed_bus",
          nodes: { item_map: "/project1/rss_feed_bus/item_map" },
          warnings: [],
        });
      }),
    );

    const args = connectRssFeedBusSchema.parse({
      feed_label: "newswire",
      item_count: 5,
      category_count: 2,
    });
    const result = await connectRssFeedBusImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.feed_label).toBe("newswire");
    expect(payload.nodes.find((node) => node.name === "rss_feed_client")?.optype).toBe(
      "webclientDAT",
    );
    expect(payload.nodes.find((node) => node.name === "item_map")?.table?.join(" ")).toContain(
      "item_5",
    );
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created RSS feed bus");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "rss_feed_bus", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectRssFeedBusImpl(makeCtx(), connectRssFeedBusSchema.parse({}));

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_rss_feed_bus failed");
  });

  it("rejects invalid item counts", () => {
    expect(() => connectRssFeedBusSchema.parse({ item_count: 0 })).toThrow();
  });
});
