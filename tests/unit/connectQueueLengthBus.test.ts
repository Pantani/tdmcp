import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectQueueLengthBusImpl,
  connectQueueLengthBusSchema,
} from "../../src/tools/layer2/connectQueueLengthBus.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectQueueLengthBusImpl", () => {
  it("builds a queue-length bus scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "queue_length_bus",
          container_path: "/project1/queue_length_bus",
          nodes: { queue_metrics: "/project1/queue_length_bus/queue_metrics" },
          warnings: [],
        });
      }),
    );

    const args = connectQueueLengthBusSchema.parse({
      queue_label: "entry",
      queue_count: 3,
      sample_count: 9,
      alert_threshold_people: 42,
    });
    const result = await connectQueueLengthBusImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.queue_label).toBe("entry");
    expect(payload.metadata.alert_threshold_people).toBe(42);
    expect(payload.nodes.find((node) => node.name === "queue_metrics")?.table?.join(" ")).toContain(
      "queue_3",
    );
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created queue-length bus");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "queue_length_bus", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectQueueLengthBusImpl(
      makeCtx(),
      connectQueueLengthBusSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_queue_length_bus failed");
  });

  it("rejects invalid queue counts", () => {
    expect(() => connectQueueLengthBusSchema.parse({ queue_count: 0 })).toThrow();
  });
});
