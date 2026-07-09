import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectGrafanaAnnotationBridgeImpl,
  connectGrafanaAnnotationBridgeSchema,
} from "../../src/tools/layer2/connectGrafanaAnnotationBridge.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectGrafanaAnnotationBridgeImpl", () => {
  it("builds a Grafana annotation bridge scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "grafana_annotation_bridge",
          container_path: "/project1/grafana_annotation_bridge",
          nodes: { panel_map: "/project1/grafana_annotation_bridge/panel_map" },
          warnings: [],
        });
      }),
    );

    const args = connectGrafanaAnnotationBridgeSchema.parse({
      dashboard_uid: "venue-main",
      panel_count: 3,
      tag_count: 2,
    });
    const result = await connectGrafanaAnnotationBridgeImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.dashboard_uid).toBe("venue-main");
    expect(payload.nodes.find((node) => node.name === "grafana_client")?.optype).toBe(
      "webclientDAT",
    );
    expect(payload.nodes.find((node) => node.name === "panel_map")?.table?.join(" ")).toContain(
      "panel_3",
    );
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created Grafana annotation bridge");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({
          kind: "grafana_annotation_bridge",
          warnings: [],
          fatal: "Parent COMP not found",
        }),
      ),
    );

    const result = await connectGrafanaAnnotationBridgeImpl(
      makeCtx(),
      connectGrafanaAnnotationBridgeSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_grafana_annotation_bridge failed");
  });

  it("rejects invalid panel counts", () => {
    expect(() => connectGrafanaAnnotationBridgeSchema.parse({ panel_count: 0 })).toThrow();
  });
});
