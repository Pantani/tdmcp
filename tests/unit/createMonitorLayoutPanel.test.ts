import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createMonitorLayoutPanelImpl,
  createMonitorLayoutPanelSchema,
} from "../../src/tools/layer2/createMonitorLayoutPanel.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("createMonitorLayoutPanelImpl", () => {
  it("builds a monitor layout panel scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "monitor_layout_panel",
          container_path: "/project1/monitor_layout_panel",
          nodes: { monitor_map: "/project1/monitor_layout_panel/monitor_map" },
          warnings: [],
        });
      }),
    );

    const args = createMonitorLayoutPanelSchema.parse({
      monitor_count: 4,
      gpu_count: 2,
      include_direct_display_hint: false,
    });
    const result = await createMonitorLayoutPanelImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.gpu_count).toBe(2);
    expect(payload.nodes.find((node) => node.name === "monitors")?.optype).toBe("monitorsDAT");
    expect(payload.nodes.find((node) => node.name === "monitor_map")?.table?.join(" ")).toContain(
      "monitor_4",
    );
    expect(payload.nodes.find((node) => node.name === "gpu_map")?.table?.join(" ")).toContain(
      "gpu_2",
    );
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created monitor layout panel");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "monitor_layout_panel", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await createMonitorLayoutPanelImpl(
      makeCtx(),
      createMonitorLayoutPanelSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("create_monitor_layout_panel failed");
  });

  it("rejects invalid monitor counts", () => {
    expect(() => createMonitorLayoutPanelSchema.parse({ monitor_count: 0 })).toThrow();
  });
});
