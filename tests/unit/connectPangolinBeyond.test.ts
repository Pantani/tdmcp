import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectPangolinBeyondImpl,
  connectPangolinBeyondSchema,
} from "../../src/tools/layer2/connectPangolinBeyond.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectPangolinBeyondImpl", () => {
  it("builds a safety-gated Pangolin scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "pangolin_beyond",
          container_path: "/project1/pangolin_beyond",
          nodes: { zone_map: "/project1/pangolin_beyond/zone_map" },
          warnings: [],
        });
      }),
    );

    const args = connectPangolinBeyondSchema.parse({
      zone_count: 3,
      cue_count: 4,
      output_rate: 24,
      active: false,
    });
    const result = await connectPangolinBeyondImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.kind).toBe("pangolin_beyond");
    expect(payload.metadata.safety_blackout).toBe(true);
    expect(payload.nodes.find((node) => node.name === "zone_map")?.table?.join(" ")).toContain(
      "zone_3",
    );
    expect(payload.nodes.find((node) => node.name === "cue_map")?.table?.join(" ")).toContain(
      "beyond:cue:4",
    );
    expect(capturedScript).toContain("nodeX");
    expect(capturedScript).toContain("_replace_unsupported_node");
    expect(textOf(result)).toContain("Created Pangolin Beyond scaffold");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "pangolin_beyond", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectPangolinBeyondImpl(
      makeCtx(),
      connectPangolinBeyondSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_pangolin_beyond failed");
  });

  it("rejects invalid zone counts", () => {
    expect(() => connectPangolinBeyondSchema.parse({ zone_count: 0 })).toThrow();
  });
});
