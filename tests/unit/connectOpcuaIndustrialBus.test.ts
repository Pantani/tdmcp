import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectOpcuaIndustrialBusImpl,
  connectOpcuaIndustrialBusSchema,
} from "../../src/tools/layer2/connectOpcuaIndustrialBus.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectOpcuaIndustrialBusImpl", () => {
  it("builds an OPC UA industrial bus scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "opcua_industrial_bus",
          container_path: "/project1/opcua_industrial_bus",
          nodes: { node_map: "/project1/opcua_industrial_bus/node_map" },
          warnings: [],
        });
      }),
    );

    const args = connectOpcuaIndustrialBusSchema.parse({
      adapter_mode: "websocket_json",
      endpoint_url: "opc.tcp://plc.local:4840",
      namespace_index: 4,
      node_count: 5,
    });
    const result = await connectOpcuaIndustrialBusImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.endpoint_url).toBe("opc.tcp://plc.local:4840");
    expect(payload.nodes.find((node) => node.name === "opcua_ws_adapter")?.optype).toBe(
      "websocketDAT",
    );
    expect(payload.nodes.find((node) => node.name === "node_map")?.table?.join(" ")).toContain(
      "ns=4;s=Show.Node5",
    );
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created OPC UA industrial bus");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "opcua_industrial_bus", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectOpcuaIndustrialBusImpl(
      makeCtx(),
      connectOpcuaIndustrialBusSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_opcua_industrial_bus failed");
  });

  it("rejects invalid poll periods", () => {
    expect(() => connectOpcuaIndustrialBusSchema.parse({ poll_ms: 10 })).toThrow();
  });
});
