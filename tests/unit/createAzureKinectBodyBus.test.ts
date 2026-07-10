import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createAzureKinectBodyBusImpl,
  createAzureKinectBodyBusSchema,
} from "../../src/tools/layer2/createAzureKinectBodyBus.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("createAzureKinectBodyBusImpl", () => {
  it("builds an Azure Kinect body bus scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "azure_kinect_body_bus",
          container_path: "/project1/azure_kinect_body_bus",
          nodes: { body_map: "/project1/azure_kinect_body_bus/body_map" },
          warnings: [],
        });
      }),
    );

    const args = createAzureKinectBodyBusSchema.parse({
      device_index: 1,
      body_count: 3,
      include_color_top: false,
    });
    const result = await createAzureKinectBodyBusImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.kind).toBe("azure_kinect_body_bus");
    expect(payload.metadata.device_index).toBe(1);
    expect(payload.nodes.find((node) => node.name === "kinect_chop")?.optype).toBe(
      "kinectazureCHOP",
    );
    expect(payload.nodes.find((node) => node.name === "body_map")?.table?.join(" ")).toContain(
      "body2_joint_",
    );
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created Azure Kinect body bus");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "azure_kinect_body_bus", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await createAzureKinectBodyBusImpl(
      makeCtx(),
      createAzureKinectBodyBusSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("create_azure_kinect_body_bus failed");
  });

  it("rejects invalid body counts", () => {
    expect(() => createAzureKinectBodyBusSchema.parse({ body_count: 0 })).toThrow();
  });
});
