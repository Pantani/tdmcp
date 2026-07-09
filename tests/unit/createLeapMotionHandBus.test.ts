import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createLeapMotionHandBusImpl,
  createLeapMotionHandBusSchema,
} from "../../src/tools/layer2/createLeapMotionHandBus.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("createLeapMotionHandBusImpl", () => {
  it("builds a Leap Motion hand bus scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "leap_motion_hand_bus",
          container_path: "/project1/leap_motion_hand_bus",
          nodes: { hand_map: "/project1/leap_motion_hand_bus/hand_map" },
          warnings: [],
        });
      }),
    );

    const args = createLeapMotionHandBusSchema.parse({
      hand_count: 2,
      gesture_count: 4,
      include_image_top: true,
    });
    const result = await createLeapMotionHandBusImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.include_image_top).toBe(true);
    expect(payload.nodes.find((node) => node.name === "leap_chop")?.optype).toBe("leapmotionCHOP");
    expect(payload.nodes.find((node) => node.name === "hand_map")?.table?.join(" ")).toContain(
      "hand1_",
    );
    expect(payload.nodes.find((node) => node.name === "gesture_map")?.table?.join(" ")).toContain(
      "circle",
    );
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created Leap Motion hand bus");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "leap_motion_hand_bus", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await createLeapMotionHandBusImpl(
      makeCtx(),
      createLeapMotionHandBusSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("create_leap_motion_hand_bus failed");
  });

  it("rejects invalid hand counts", () => {
    expect(() => createLeapMotionHandBusSchema.parse({ hand_count: 0 })).toThrow();
  });
});
