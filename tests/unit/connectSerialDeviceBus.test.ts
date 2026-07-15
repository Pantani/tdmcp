import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectSerialDeviceBusImpl,
  connectSerialDeviceBusSchema,
} from "../../src/tools/layer2/connectSerialDeviceBus.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectSerialDeviceBusImpl", () => {
  it("builds a serial device bus scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "serial_device_bus",
          container_path: "/project1/serial_device_bus",
          nodes: { message_map: "/project1/serial_device_bus/message_map" },
          warnings: [],
        });
      }),
    );

    const args = connectSerialDeviceBusSchema.parse({
      device: "/dev/tty.usbmodem01",
      baud_rate: 57600,
      message_count: 4,
      include_chop: false,
    });
    const result = await connectSerialDeviceBusImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.device).toBe("/dev/tty.usbmodem01");
    expect(payload.nodes.find((node) => node.name === "serial_dat")?.optype).toBe("serialDAT");
    expect(payload.nodes.find((node) => node.name === "serial_chop")?.optype).toBe("serialCHOP");
    expect(payload.nodes.find((node) => node.name === "message_map")?.table?.join(" ")).toContain(
      "msg4:",
    );
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created serial device bus");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "serial_device_bus", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectSerialDeviceBusImpl(
      makeCtx(),
      connectSerialDeviceBusSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_serial_device_bus failed");
  });

  it("rejects invalid baud rates", () => {
    expect(() => connectSerialDeviceBusSchema.parse({ baud_rate: 100 })).toThrow();
  });
});
