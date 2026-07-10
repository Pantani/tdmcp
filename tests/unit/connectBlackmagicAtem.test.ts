import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectBlackmagicAtemImpl,
  connectBlackmagicAtemSchema,
} from "../../src/tools/layer2/connectBlackmagicAtem.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectBlackmagicAtemImpl", () => {
  it("builds an ATEM command-map scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        capturedScript = String(body.script ?? "");
        expect(body.return_output).toBe(true);
        return execOk({
          kind: "blackmagic_atem",
          container_path: "/project1/blackmagic_atem",
          nodes: { action_map: "/project1/blackmagic_atem/action_map" },
          warnings: [],
        });
      }),
    );

    const args = connectBlackmagicAtemSchema.parse({
      atem_host: "10.10.1.50",
      input_count: 4,
      macro_count: 3,
      active: true,
    });
    const result = await connectBlackmagicAtemImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.kind).toBe("blackmagic_atem");
    expect(payload.metadata.atem_host).toBe("10.10.1.50");
    expect(payload.nodes.find((node) => node.name === "input_map")?.table?.join(" ")).toContain(
      "program:4",
    );
    expect(payload.nodes.find((node) => node.name === "action_map")?.table?.join(" ")).toContain(
      "macro:run:3",
    );
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created Blackmagic ATEM scaffold");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "blackmagic_atem", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectBlackmagicAtemImpl(
      makeCtx(),
      connectBlackmagicAtemSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_blackmagic_atem failed");
  });

  it("rejects invalid input counts", () => {
    expect(() => connectBlackmagicAtemSchema.parse({ input_count: 0 })).toThrow();
  });
});
