import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectDisguiseStageImpl,
  connectDisguiseStageSchema,
} from "../../src/tools/layer2/connectDisguiseStage.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectDisguiseStageImpl", () => {
  it("builds a disguise stage scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "disguise_stage",
          container_path: "/project1/disguise_stage",
          nodes: { timeline_map: "/project1/disguise_stage/timeline_map" },
          warnings: [],
        });
      }),
    );

    const args = connectDisguiseStageSchema.parse({
      api_host: "10.0.0.70",
      api_port: 9001,
      timeline_count: 2,
      layer_count: 4,
    });
    const result = await connectDisguiseStageImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.api_host).toBe("10.0.0.70");
    expect(payload.nodes.find((node) => node.name === "api_client")?.params?.url).toBe(
      "http://10.0.0.70:9001/api/session",
    );
    expect(payload.nodes.find((node) => node.name === "timeline_map")?.table?.join(" ")).toContain(
      "/api/session/timelines/2/play",
    );
    expect(payload.nodes.find((node) => node.name === "layer_map")?.table?.join(" ")).toContain(
      "/disguise/layer/4/visible",
    );
    expect(capturedScript).toContain("nodeX");
    expect(textOf(result)).toContain("Created disguise stage scaffold");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "disguise_stage", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectDisguiseStageImpl(makeCtx(), connectDisguiseStageSchema.parse({}));

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_disguise_stage failed");
  });

  it("rejects invalid timeline counts", () => {
    expect(() => connectDisguiseStageSchema.parse({ timeline_count: 0 })).toThrow();
  });
});
