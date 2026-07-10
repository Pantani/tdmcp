import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectRedisPubsubBusImpl,
  connectRedisPubsubBusSchema,
} from "../../src/tools/layer2/connectRedisPubsubBus.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectRedisPubsubBusImpl", () => {
  it("builds a Redis Pub/Sub bus scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "redis_pubsub_bus",
          container_path: "/project1/redis_pubsub_bus",
          nodes: { channel_map: "/project1/redis_pubsub_bus/channel_map" },
          warnings: [],
        });
      }),
    );

    const args = connectRedisPubsubBusSchema.parse({
      redis_host: "redis.local",
      channel_root: "venue:show",
      channel_count: 4,
      stream_mode: "both",
    });
    const result = await connectRedisPubsubBusImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.redis_host).toBe("redis.local");
    expect(payload.nodes.find((node) => node.name === "redis_ws_adapter")?.optype).toBe(
      "websocketDAT",
    );
    expect(payload.nodes.find((node) => node.name === "channel_map")?.table?.join(" ")).toContain(
      "venue:show:4",
    );
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created Redis Pub/Sub bus");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "redis_pubsub_bus", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectRedisPubsubBusImpl(
      makeCtx(),
      connectRedisPubsubBusSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_redis_pubsub_bus failed");
  });

  it("rejects invalid Redis ports", () => {
    expect(() => connectRedisPubsubBusSchema.parse({ redis_port: 0 })).toThrow();
  });
});
