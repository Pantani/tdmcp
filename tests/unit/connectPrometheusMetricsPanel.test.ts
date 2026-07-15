import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectPrometheusMetricsPanelImpl,
  connectPrometheusMetricsPanelSchema,
} from "../../src/tools/layer2/connectPrometheusMetricsPanel.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectPrometheusMetricsPanelImpl", () => {
  it("builds a Prometheus metrics panel scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "prometheus_metrics_panel",
          container_path: "/project1/prometheus_metrics_panel",
          nodes: { metric_map: "/project1/prometheus_metrics_panel/metric_map" },
          warnings: [],
        });
      }),
    );

    const args = connectPrometheusMetricsPanelSchema.parse({
      job_name: "show_api",
      metric_count: 4,
      alert_count: 2,
    });
    const result = await connectPrometheusMetricsPanelImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.job_name).toBe("show_api");
    expect(payload.nodes.find((node) => node.name === "promql_client")?.optype).toBe(
      "webclientDAT",
    );
    expect(payload.nodes.find((node) => node.name === "metric_map")?.table?.join(" ")).toContain(
      "show_api_metric_4",
    );
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created Prometheus metrics panel");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "prometheus_metrics_panel", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectPrometheusMetricsPanelImpl(
      makeCtx(),
      connectPrometheusMetricsPanelSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_prometheus_metrics_panel failed");
  });

  it("rejects invalid metric counts", () => {
    expect(() => connectPrometheusMetricsPanelSchema.parse({ metric_count: 0 })).toThrow();
  });
});
