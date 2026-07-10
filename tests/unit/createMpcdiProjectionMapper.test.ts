import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createMpcdiProjectionMapperImpl,
  createMpcdiProjectionMapperSchema,
} from "../../src/tools/layer2/createMpcdiProjectionMapper.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("createMpcdiProjectionMapperImpl", () => {
  it("builds an MPCDI projection mapper scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "mpcdi_projection_mapper",
          container_path: "/project1/mpcdi_projection_mapper",
          nodes: { region_map: "/project1/mpcdi_projection_mapper/region_map" },
          warnings: [],
        });
      }),
    );

    const args = createMpcdiProjectionMapperSchema.parse({
      config_file: "/calibration/stage.mpcdi",
      projector_count: 3,
      region_count: 5,
    });
    const result = await createMpcdiProjectionMapperImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.config_file).toBe("/calibration/stage.mpcdi");
    expect(payload.nodes.find((node) => node.name === "mpcdi_warp")?.optype).toBe("mpcdiTOP");
    expect(payload.nodes.find((node) => node.name === "mpcdi_info")?.optype).toBe("mpcdiDAT");
    expect(payload.nodes.find((node) => node.name === "region_map")?.table?.join(" ")).toContain(
      "region_5",
    );
    expect(payload.connections).toContainEqual({ from: "mpcdi_warp", to: "warp_out" });
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created MPCDI projection mapper");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "mpcdi_projection_mapper", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await createMpcdiProjectionMapperImpl(
      makeCtx(),
      createMpcdiProjectionMapperSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("create_mpcdi_projection_mapper failed");
  });

  it("rejects invalid region counts", () => {
    expect(() => createMpcdiProjectionMapperSchema.parse({ region_count: 0 })).toThrow();
  });
});
