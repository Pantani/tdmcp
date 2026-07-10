import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createScalableDisplayBusImpl,
  createScalableDisplayBusSchema,
} from "../../src/tools/layer2/createScalableDisplayBus.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("createScalableDisplayBusImpl", () => {
  it("builds a Scalable Display bus scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "scalable_display_bus",
          container_path: "/project1/scalable_display_bus",
          nodes: { tile_map: "/project1/scalable_display_bus/tile_map" },
          warnings: [],
        });
      }),
    );

    const args = createScalableDisplayBusSchema.parse({
      config_file: "/calibration/scalable.xml",
      display_count: 4,
      canvas_width: 7680,
      canvas_height: 2160,
    });
    const result = await createScalableDisplayBusImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.canvas_width).toBe(7680);
    expect(payload.nodes.find((node) => node.name === "scalable_display")?.optype).toBe(
      "scalabledisplayTOP",
    );
    expect(payload.nodes.find((node) => node.name === "tile_map")?.table?.join(" ")).toContain(
      "display_4",
    );
    expect(payload.connections).toContainEqual({ from: "scalable_display", to: "display_out" });
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created Scalable Display bus");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "scalable_display_bus", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await createScalableDisplayBusImpl(
      makeCtx(),
      createScalableDisplayBusSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("create_scalable_display_bus failed");
  });

  it("rejects invalid display counts", () => {
    expect(() => createScalableDisplayBusSchema.parse({ display_count: 0 })).toThrow();
  });
});
