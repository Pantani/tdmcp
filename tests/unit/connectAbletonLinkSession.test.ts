import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectAbletonLinkSessionImpl,
  connectAbletonLinkSessionSchema,
} from "../../src/tools/layer2/connectAbletonLinkSession.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectAbletonLinkSessionImpl", () => {
  it("builds an Ableton Link timing scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "ableton_link_session",
          container_path: "/project1/ableton_link_session",
          nodes: { beat_map: "/project1/ableton_link_session/beat_map" },
          warnings: [],
        });
      }),
    );

    const args = connectAbletonLinkSessionSchema.parse({
      tempo_hint: 128,
      signature: 3,
      export_bars: 2,
      start_stop_sync: true,
    });
    const result = await connectAbletonLinkSessionImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.tempo_hint).toBe(128);
    expect(payload.nodes.find((node) => node.name === "beat_map")?.table).toHaveLength(7);
    expect(payload.nodes.find((node) => node.name === "beat_map")?.table?.join(" ")).toContain(
      "bar_2_beat_3",
    );
    expect(capturedScript).toContain("nodeX");
    expect(textOf(result)).toContain("Created Ableton Link session scaffold");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "ableton_link_session", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectAbletonLinkSessionImpl(
      makeCtx(),
      connectAbletonLinkSessionSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_ableton_link_session failed");
  });

  it("rejects invalid tempo hints", () => {
    expect(() => connectAbletonLinkSessionSchema.parse({ tempo_hint: 10 })).toThrow();
  });
});
