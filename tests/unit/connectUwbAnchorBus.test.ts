import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectUwbAnchorBusImpl,
  connectUwbAnchorBusSchema,
} from "../../src/tools/layer2/connectUwbAnchorBus.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectUwbAnchorBusImpl", () => {
  it("builds a UWB anchor bus scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "uwb_anchor_bus",
          container_path: "/project1/uwb_anchor_bus",
          nodes: { tag_position_map: "/project1/uwb_anchor_bus/tag_position_map" },
          warnings: [],
        });
      }),
    );

    const args = connectUwbAnchorBusSchema.parse({
      space_label: "blackbox",
      anchor_count: 6,
      tag_count: 5,
    });
    const result = await connectUwbAnchorBusImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.space_label).toBe("blackbox");
    expect(payload.nodes.find((node) => node.name === "uwb_ws_adapter")?.optype).toBe(
      "websocketDAT",
    );
    expect(
      payload.nodes.find((node) => node.name === "tag_position_map")?.table?.join(" "),
    ).toContain("tag_ref_5");
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created UWB anchor bus");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "uwb_anchor_bus", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectUwbAnchorBusImpl(makeCtx(), connectUwbAnchorBusSchema.parse({}));

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_uwb_anchor_bus failed");
  });

  it("rejects invalid anchor counts", () => {
    expect(() => connectUwbAnchorBusSchema.parse({ anchor_count: 2 })).toThrow();
  });
});
