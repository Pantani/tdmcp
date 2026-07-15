import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectSlackOpsBridgeImpl,
  connectSlackOpsBridgeSchema,
} from "../../src/tools/layer2/connectSlackOpsBridge.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectSlackOpsBridgeImpl", () => {
  it("builds a Slack ops bridge scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "slack_ops_bridge",
          container_path: "/project1/slack_ops_bridge",
          nodes: { alert_map: "/project1/slack_ops_bridge/alert_map" },
          warnings: [],
        });
      }),
    );

    const args = connectSlackOpsBridgeSchema.parse({
      channel_name: "#stage",
      alert_count: 3,
      command_count: 2,
    });
    const result = await connectSlackOpsBridgeImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.channel_name).toBe("#stage");
    expect(payload.nodes.find((node) => node.name === "slack_webhook_client")?.optype).toBe(
      "webclientDAT",
    );
    expect(payload.nodes.find((node) => node.name === "command_map")?.table?.join(" ")).toContain(
      "/tdmcp_2",
    );
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created Slack ops bridge");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "slack_ops_bridge", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectSlackOpsBridgeImpl(
      makeCtx(),
      connectSlackOpsBridgeSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_slack_ops_bridge failed");
  });

  it("rejects negative command counts", () => {
    expect(() => connectSlackOpsBridgeSchema.parse({ command_count: -1 })).toThrow();
  });
});
