import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectDoorAccessBusImpl,
  connectDoorAccessBusSchema,
} from "../../src/tools/layer2/connectDoorAccessBus.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectDoorAccessBusImpl", () => {
  it("builds a door-access bus scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "door_access_bus",
          container_path: "/project1/door_access_bus",
          nodes: { door_events: "/project1/door_access_bus/door_events" },
          warnings: [],
        });
      }),
    );

    const args = connectDoorAccessBusSchema.parse({
      venue_label: "gallery",
      door_count: 5,
      event_count: 7,
      policy_mode: "approval_required",
    });
    const result = await connectDoorAccessBusImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.policy_mode).toBe("approval_required");
    expect(payload.nodes.find((node) => node.name === "door_events")?.table?.join(" ")).toContain(
      "door_event_7",
    );
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created door-access bus");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "door_access_bus", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectDoorAccessBusImpl(makeCtx(), connectDoorAccessBusSchema.parse({}));

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_door_access_bus failed");
  });

  it("rejects invalid door counts", () => {
    expect(() => connectDoorAccessBusSchema.parse({ door_count: 0 })).toThrow();
  });
});
