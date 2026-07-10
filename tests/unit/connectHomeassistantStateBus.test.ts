import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectHomeassistantStateBusImpl,
  connectHomeassistantStateBusSchema,
} from "../../src/tools/layer2/connectHomeassistantStateBus.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectHomeassistantStateBusImpl", () => {
  it("builds a Home Assistant state bus scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "homeassistant_state_bus",
          container_path: "/project1/homeassistant_state_bus",
          nodes: { entity_map: "/project1/homeassistant_state_bus/entity_map" },
          warnings: [],
        });
      }),
    );

    const args = connectHomeassistantStateBusSchema.parse({
      entity_domain: "light",
      entity_count: 4,
      service_count: 2,
      area_count: 2,
    });
    const result = await connectHomeassistantStateBusImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.entity_domain).toBe("light");
    expect(payload.nodes.find((node) => node.name === "ha_ws_adapter")?.optype).toBe(
      "websocketDAT",
    );
    expect(payload.nodes.find((node) => node.name === "entity_map")?.table?.join(" ")).toContain(
      "light.tdmcp_4",
    );
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created Home Assistant state bus");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "homeassistant_state_bus", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectHomeassistantStateBusImpl(
      makeCtx(),
      connectHomeassistantStateBusSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_homeassistant_state_bus failed");
  });

  it("rejects invalid entity counts", () => {
    expect(() => connectHomeassistantStateBusSchema.parse({ entity_count: 0 })).toThrow();
  });
});
