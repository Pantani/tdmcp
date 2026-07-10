import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectReaperTransportImpl,
  connectReaperTransportSchema,
} from "../../src/tools/layer2/connectReaperTransport.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectReaperTransportImpl", () => {
  it("builds a REAPER OSC transport payload", async () => {
    let capturedScript = "";

    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown };
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "reaper_transport",
          container_path: "/project1/reaper_transport",
          nodes: { transport_map: "/project1/reaper_transport/transport_map" },
          warnings: [],
        });
      }),
    );

    const args = connectReaperTransportSchema.parse({
      reaper_host: "10.0.0.93",
      project_name: "tour",
      track_count: 4,
      marker_count: 2,
      include_record: true,
      active: true,
    });
    const result = await connectReaperTransportImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.kind).toBe("reaper_transport");
    expect(payload.metadata.project_name).toBe("tour");
    expect(payload.nodes.find((node) => node.name === "transport_map")?.table?.join(" ")).toContain(
      "/record",
    );
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created REAPER transport scaffold");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "reaper_transport", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectReaperTransportImpl(
      makeCtx(),
      connectReaperTransportSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_reaper_transport failed");
  });

  it("rejects invalid track counts", () => {
    expect(() => connectReaperTransportSchema.parse({ track_count: 0 })).toThrow();
  });
});
