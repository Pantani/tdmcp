import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectWebsocketControlBusImpl,
  connectWebsocketControlBusSchema,
} from "../../src/tools/layer2/connectWebsocketControlBus.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectWebsocketControlBusImpl", () => {
  it("builds a WebSocket control bus scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "websocket_control_bus",
          container_path: "/project1/websocket_control_bus",
          nodes: { command_map: "/project1/websocket_control_bus/command_map" },
          warnings: [],
        });
      }),
    );

    const args = connectWebsocketControlBusSchema.parse({
      net_address: "show.local",
      port: 8443,
      path: "control",
      tls: true,
      command_count: 3,
    });
    const result = await connectWebsocketControlBusImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.url).toBe("wss://show.local:8443/control");
    expect(payload.nodes.find((node) => node.name === "websocket")?.optype).toBe("websocketDAT");
    expect(payload.nodes.find((node) => node.name === "command_map")?.table?.join(" ")).toContain(
      "show.command.3",
    );
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created WebSocket control bus");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "websocket_control_bus", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectWebsocketControlBusImpl(
      makeCtx(),
      connectWebsocketControlBusSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_websocket_control_bus failed");
  });

  it("rejects invalid command counts", () => {
    expect(() => connectWebsocketControlBusSchema.parse({ command_count: 0 })).toThrow();
  });
});
