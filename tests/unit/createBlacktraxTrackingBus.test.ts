import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createBlacktraxTrackingBusImpl,
  createBlacktraxTrackingBusSchema,
} from "../../src/tools/layer2/createBlacktraxTrackingBus.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("createBlacktraxTrackingBusImpl", () => {
  it("builds a BlackTrax tracking bus scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "blacktrax_tracking_bus",
          container_path: "/project1/blacktrax_tracking_bus",
          nodes: { trackable_map: "/project1/blacktrax_tracking_bus/trackable_map" },
          warnings: [],
        });
      }),
    );

    const args = createBlacktraxTrackingBusSchema.parse({
      port: 24005,
      trackable_count: 3,
      zone_count: 2,
    });
    const result = await createBlacktraxTrackingBusImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.kind).toBe("blacktrax_tracking_bus");
    expect(payload.metadata.port).toBe(24005);
    expect(payload.nodes.find((node) => node.name === "blacktrax_in")?.optype).toBe(
      "blacktraxCHOP",
    );
    expect(payload.nodes.find((node) => node.name === "trackable_map")?.table?.join(" ")).toContain(
      "bt_3_",
    );
    expect(payload.nodes.find((node) => node.name === "zone_map")?.table?.join(" ")).toContain(
      "zone_2",
    );
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created BlackTrax tracking bus");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "blacktrax_tracking_bus", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await createBlacktraxTrackingBusImpl(
      makeCtx(),
      createBlacktraxTrackingBusSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("create_blacktrax_tracking_bus failed");
  });

  it("rejects invalid trackable counts", () => {
    expect(() => createBlacktraxTrackingBusSchema.parse({ trackable_count: 0 })).toThrow();
  });
});
