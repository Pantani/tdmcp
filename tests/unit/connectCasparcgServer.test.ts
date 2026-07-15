import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectCasparcgServerImpl,
  connectCasparcgServerSchema,
} from "../../src/tools/layer2/connectCasparcgServer.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectCasparcgServerImpl", () => {
  it("builds a CasparCG AMCP scaffold payload", async () => {
    let capturedScript = "";

    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "casparcg_server",
          container_path: "/project1/casparcg_server",
          nodes: { command_map: "/project1/casparcg_server/command_map" },
          warnings: [],
        });
      }),
    );

    const args = connectCasparcgServerSchema.parse({
      caspar_host: "10.0.0.80",
      amcp_port: 5251,
      channel_count: 2,
      layer_count: 2,
      media_root_hint: "media/show/",
      active: true,
    });
    const result = await connectCasparcgServerImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.kind).toBe("casparcg_server");
    expect(payload.metadata.caspar_host).toBe("10.0.0.80");
    expect(payload.nodes.find((node) => node.name === "command_map")?.table?.join(" ")).toContain(
      "LOADBG 1-1",
    );
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created CasparCG server scaffold");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "casparcg_server", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectCasparcgServerImpl(
      makeCtx(),
      connectCasparcgServerSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_casparcg_server failed");
  });

  it("rejects invalid layer counts", () => {
    expect(() => connectCasparcgServerSchema.parse({ layer_count: 0 })).toThrow();
  });
});
