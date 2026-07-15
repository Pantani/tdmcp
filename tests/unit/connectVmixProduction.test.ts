import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectVmixProductionImpl,
  connectVmixProductionSchema,
} from "../../src/tools/layer2/connectVmixProduction.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectVmixProductionImpl", () => {
  it("builds a vMix API command scaffold payload", async () => {
    let capturedScript = "";

    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown };
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "vmix_production",
          container_path: "/project1/vmix_production",
          nodes: { command_map: "/project1/vmix_production/command_map" },
          warnings: [],
        });
      }),
    );

    const args = connectVmixProductionSchema.parse({
      vmix_host: "10.0.0.70",
      api_port: 8090,
      input_count: 6,
      overlay_count: 2,
      include_record_stream: true,
      active: false,
    });
    const result = await connectVmixProductionImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.kind).toBe("vmix_production");
    expect(payload.metadata.vmix_host).toBe("10.0.0.70");
    expect(payload.nodes.find((node) => node.name === "command_map")?.table?.join(" ")).toContain(
      "StartRecording",
    );
    expect(capturedScript).toContain("nodeX");
    expect(textOf(result)).toContain("Created vMix production scaffold");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "vmix_production", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectVmixProductionImpl(
      makeCtx(),
      connectVmixProductionSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_vmix_production failed");
  });

  it("rejects invalid API ports", () => {
    expect(() => connectVmixProductionSchema.parse({ api_port: 0 })).toThrow();
  });
});
