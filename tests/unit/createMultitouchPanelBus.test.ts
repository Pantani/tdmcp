import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createMultitouchPanelBusImpl,
  createMultitouchPanelBusSchema,
} from "../../src/tools/layer2/createMultitouchPanelBus.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("createMultitouchPanelBusImpl", () => {
  it("builds a Multi Touch panel bus scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "multitouch_panel_bus",
          container_path: "/project1/multitouch_panel_bus",
          nodes: { panel_map: "/project1/multitouch_panel_bus/panel_map" },
          warnings: [],
        });
      }),
    );

    const args = createMultitouchPanelBusSchema.parse({
      panel_count: 3,
      max_touches: 4,
      mouse_as_touch: true,
    });
    const result = await createMultitouchPanelBusImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.mouse_as_touch).toBe(true);
    expect(payload.nodes.find((node) => node.name === "multi_touch_in")?.optype).toBe(
      "multitouchinDAT",
    );
    expect(payload.nodes.find((node) => node.name === "touch_panel")?.optype).toBe("containerCOMP");
    expect(payload.nodes.find((node) => node.name === "panel_map")?.table?.join(" ")).toContain(
      "panel_3",
    );
    expect(payload.nodes.find((node) => node.name === "touch_map")?.table?.join(" ")).toContain(
      "touch3_state",
    );
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created Multi Touch panel bus");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "multitouch_panel_bus", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await createMultitouchPanelBusImpl(
      makeCtx(),
      createMultitouchPanelBusSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("create_multitouch_panel_bus failed");
  });

  it("rejects invalid touch counts", () => {
    expect(() => createMultitouchPanelBusSchema.parse({ max_touches: 0 })).toThrow();
  });
});
