import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectMatrixRoomBusImpl,
  connectMatrixRoomBusSchema,
} from "../../src/tools/layer2/connectMatrixRoomBus.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectMatrixRoomBusImpl", () => {
  it("builds a Matrix room bus scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "matrix_room_bus",
          container_path: "/project1/matrix_room_bus",
          nodes: { room_event_map: "/project1/matrix_room_bus/room_event_map" },
          warnings: [],
        });
      }),
    );

    const args = connectMatrixRoomBusSchema.parse({
      homeserver_label: "synapse",
      room_alias: "#venue:example.org",
      room_event_count: 4,
      reaction_count: 2,
    });
    const result = await connectMatrixRoomBusImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.room_alias).toBe("#venue:example.org");
    expect(payload.nodes.find((node) => node.name === "matrix_sync_client")?.optype).toBe(
      "webclientDAT",
    );
    expect(
      payload.nodes.find((node) => node.name === "room_event_map")?.table?.join(" "),
    ).toContain("event_4");
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created Matrix room bus");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "matrix_room_bus", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectMatrixRoomBusImpl(makeCtx(), connectMatrixRoomBusSchema.parse({}));

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_matrix_room_bus failed");
  });

  it("rejects invalid room event counts", () => {
    expect(() => connectMatrixRoomBusSchema.parse({ room_event_count: 0 })).toThrow();
  });
});
