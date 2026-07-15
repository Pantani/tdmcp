import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectNoiseLevelBusImpl,
  connectNoiseLevelBusSchema,
} from "../../src/tools/layer2/connectNoiseLevelBus.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectNoiseLevelBusImpl", () => {
  it("builds a noise-level bus scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "noise_level_bus",
          container_path: "/project1/noise_level_bus",
          nodes: { noise_levels: "/project1/noise_level_bus/noise_levels" },
          warnings: [],
        });
      }),
    );

    const args = connectNoiseLevelBusSchema.parse({
      venue_label: "club",
      zone_count: 3,
      sample_count: 6,
      weighting: "dbc",
      limit_db: 101,
    });
    const result = await connectNoiseLevelBusImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.weighting).toBe("dbc");
    expect(payload.nodes.find((node) => node.name === "noise_levels")?.table?.join(" ")).toContain(
      "zone_3",
    );
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created noise-level bus");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "noise_level_bus", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectNoiseLevelBusImpl(makeCtx(), connectNoiseLevelBusSchema.parse({}));

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_noise_level_bus failed");
  });

  it("rejects invalid dB limits", () => {
    expect(() => connectNoiseLevelBusSchema.parse({ limit_db: 201 })).toThrow();
  });
});
