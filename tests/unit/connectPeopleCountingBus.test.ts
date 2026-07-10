import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectPeopleCountingBusImpl,
  connectPeopleCountingBusSchema,
} from "../../src/tools/layer2/connectPeopleCountingBus.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectPeopleCountingBusImpl", () => {
  it("builds a people-counting bus scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "people_counting_bus",
          container_path: "/project1/people_counting_bus",
          nodes: { zone_counts: "/project1/people_counting_bus/zone_counts" },
          warnings: [],
        });
      }),
    );

    const args = connectPeopleCountingBusSchema.parse({
      venue_label: "north_hall",
      zone_count: 4,
      sample_count: 8,
    });
    const result = await connectPeopleCountingBusImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.venue_label).toBe("north_hall");
    expect(payload.nodes.find((node) => node.name === "people_ws_adapter")?.optype).toBe(
      "websocketDAT",
    );
    expect(payload.nodes.find((node) => node.name === "zone_counts")?.table?.join(" ")).toContain(
      "zone_4",
    );
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created people-counting bus");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "people_counting_bus", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectPeopleCountingBusImpl(
      makeCtx(),
      connectPeopleCountingBusSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_people_counting_bus failed");
  });

  it("rejects invalid zone counts", () => {
    expect(() => connectPeopleCountingBusSchema.parse({ zone_count: 0 })).toThrow();
  });
});
