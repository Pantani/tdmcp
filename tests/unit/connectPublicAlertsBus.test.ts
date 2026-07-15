import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectPublicAlertsBusImpl,
  connectPublicAlertsBusSchema,
} from "../../src/tools/layer2/connectPublicAlertsBus.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectPublicAlertsBusImpl", () => {
  it("builds a public alerts bus scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "public_alerts_bus",
          container_path: "/project1/public_alerts_bus",
          nodes: { alert_map: "/project1/public_alerts_bus/alert_map" },
          warnings: [],
        });
      }),
    );

    const args = connectPublicAlertsBusSchema.parse({
      provider: "nws_alerts",
      region_label: "metro",
      alert_count: 4,
      severity_count: 3,
    });
    const result = await connectPublicAlertsBusImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.region_label).toBe("metro");
    expect(payload.nodes.find((node) => node.name === "alerts_client")?.optype).toBe(
      "webclientDAT",
    );
    expect(payload.nodes.find((node) => node.name === "alert_map")?.table?.join(" ")).toContain(
      "alert_4",
    );
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created public alerts bus");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "public_alerts_bus", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectPublicAlertsBusImpl(
      makeCtx(),
      connectPublicAlertsBusSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_public_alerts_bus failed");
  });

  it("rejects invalid alert counts", () => {
    expect(() => connectPublicAlertsBusSchema.parse({ alert_count: 0 })).toThrow();
  });
});
