import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createOptitrackTrackingBusImpl,
  createOptitrackTrackingBusSchema,
} from "../../src/tools/layer2/createOptitrackTrackingBus.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("createOptitrackTrackingBusImpl", () => {
  it("builds an OptiTrack tracking bus scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "optitrack_tracking_bus",
          container_path: "/project1/optitrack_tracking_bus",
          nodes: { rigid_body_map: "/project1/optitrack_tracking_bus/rigid_body_map" },
          warnings: [],
        });
      }),
    );

    const args = createOptitrackTrackingBusSchema.parse({
      server_address: "10.0.0.20",
      rigid_body_count: 3,
      marker_count: 5,
    });
    const result = await createOptitrackTrackingBusImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.server_address).toBe("10.0.0.20");
    expect(payload.nodes.find((node) => node.name === "optitrack_in")?.optype).toBe(
      "optitrackinCHOP",
    );
    expect(
      payload.nodes.find((node) => node.name === "rigid_body_map")?.table?.join(" "),
    ).toContain("body_3");
    expect(payload.nodes.find((node) => node.name === "marker_map")?.table?.join(" ")).toContain(
      "marker5_",
    );
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created OptiTrack tracking bus");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "optitrack_tracking_bus", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await createOptitrackTrackingBusImpl(
      makeCtx(),
      createOptitrackTrackingBusSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("create_optitrack_tracking_bus failed");
  });

  it("rejects invalid rigid body counts", () => {
    expect(() => createOptitrackTrackingBusSchema.parse({ rigid_body_count: 0 })).toThrow();
  });
});
