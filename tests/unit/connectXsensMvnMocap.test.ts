import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectXsensMvnMocapImpl,
  connectXsensMvnMocapSchema,
} from "../../src/tools/layer2/connectXsensMvnMocap.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectXsensMvnMocapImpl", () => {
  it("builds an Xsens MVN mocap scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "xsens_mvn_mocap",
          container_path: "/project1/xsens_mvn_mocap",
          nodes: { segment_map: "/project1/xsens_mvn_mocap/segment_map" },
          warnings: [],
        });
      }),
    );

    const args = connectXsensMvnMocapSchema.parse({
      source_mode: "mvn_udp_json",
      actor_count: 2,
      segment_count: 5,
    });
    const result = await connectXsensMvnMocapImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.actor_count).toBe(2);
    expect(payload.nodes.find((node) => node.name === "xsens_udp")?.optype).toBe("udpinDAT");
    expect(payload.nodes.find((node) => node.name === "segment_map")?.table?.join(" ")).toContain(
      "actor_2",
    );
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created Xsens MVN mocap scaffold");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "xsens_mvn_mocap", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectXsensMvnMocapImpl(makeCtx(), connectXsensMvnMocapSchema.parse({}));

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_xsens_mvn_mocap failed");
  });

  it("rejects invalid actor counts", () => {
    expect(() => connectXsensMvnMocapSchema.parse({ actor_count: 0 })).toThrow();
  });
});
