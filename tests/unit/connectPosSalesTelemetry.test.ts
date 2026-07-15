import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectPosSalesTelemetryImpl,
  connectPosSalesTelemetrySchema,
} from "../../src/tools/layer2/connectPosSalesTelemetry.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectPosSalesTelemetryImpl", () => {
  it("builds a POS sales telemetry scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "pos_sales_telemetry",
          container_path: "/project1/pos_sales_telemetry",
          nodes: { sales_metrics: "/project1/pos_sales_telemetry/sales_metrics" },
          warnings: [],
        });
      }),
    );

    const args = connectPosSalesTelemetrySchema.parse({
      provider: "toast",
      store_label: "lobby_bar",
      metric_count: 5,
      revenue_bucket_count: 3,
    });
    const result = await connectPosSalesTelemetryImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.store_label).toBe("lobby_bar");
    expect(payload.nodes.find((node) => node.name === "pos_client")?.optype).toBe("webclientDAT");
    expect(payload.nodes.find((node) => node.name === "sales_metrics")?.table?.join(" ")).toContain(
      "metric_5",
    );
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created POS sales telemetry");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "pos_sales_telemetry", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectPosSalesTelemetryImpl(
      makeCtx(),
      connectPosSalesTelemetrySchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_pos_sales_telemetry failed");
  });

  it("rejects invalid metric counts", () => {
    expect(() => connectPosSalesTelemetrySchema.parse({ metric_count: 0 })).toThrow();
  });
});
