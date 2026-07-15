import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectTicketingCheckinBusImpl,
  connectTicketingCheckinBusSchema,
} from "../../src/tools/layer2/connectTicketingCheckinBus.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectTicketingCheckinBusImpl", () => {
  it("builds a ticketing check-in bus scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "ticketing_checkin_bus",
          container_path: "/project1/ticketing_checkin_bus",
          nodes: { checkin_map: "/project1/ticketing_checkin_bus/checkin_map" },
          warnings: [],
        });
      }),
    );

    const args = connectTicketingCheckinBusSchema.parse({
      provider: "dice",
      event_id: "night_01",
      expected_capacity: 900,
      gate_count: 3,
    });
    const result = await connectTicketingCheckinBusImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.event_id).toBe("night_01");
    expect(payload.nodes.find((node) => node.name === "ticketing_client")?.optype).toBe(
      "webclientDAT",
    );
    expect(payload.nodes.find((node) => node.name === "checkin_map")?.table?.join(" ")).toContain(
      "gate_3",
    );
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created ticketing check-in bus");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "ticketing_checkin_bus", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectTicketingCheckinBusImpl(
      makeCtx(),
      connectTicketingCheckinBusSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_ticketing_checkin_bus failed");
  });

  it("rejects invalid capacities", () => {
    expect(() => connectTicketingCheckinBusSchema.parse({ expected_capacity: 0 })).toThrow();
  });
});
