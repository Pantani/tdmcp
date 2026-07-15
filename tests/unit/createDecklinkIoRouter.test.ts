import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createDecklinkIoRouterImpl,
  createDecklinkIoRouterSchema,
} from "../../src/tools/layer2/createDecklinkIoRouter.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("createDecklinkIoRouterImpl", () => {
  it("builds a DeckLink I/O router scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        capturedScript = String(body.script ?? "");
        expect(body.return_output).toBe(true);
        return execOk({
          kind: "decklink_io_router",
          container_path: "/project1/decklink_io_router",
          nodes: { route_map: "/project1/decklink_io_router/route_map" },
          warnings: [],
        });
      }),
    );

    const args = createDecklinkIoRouterSchema.parse({
      input_device: "DeckLink 8K Pro In",
      output_device: "DeckLink 8K Pro Out",
      signal_format: "2160p2997",
      route_count: 3,
    });
    const result = await createDecklinkIoRouterImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.signal_format).toBe("2160p2997");
    expect(payload.nodes.find((node) => node.name === "route_map")?.table?.join(" ")).toContain(
      "DeckLink 8K Pro Out_3",
    );
    expect(payload.connections).toHaveLength(2);
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created DeckLink I/O router");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "decklink_io_router", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await createDecklinkIoRouterImpl(
      makeCtx(),
      createDecklinkIoRouterSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("create_decklink_io_router failed");
  });

  it("rejects invalid route counts", () => {
    expect(() => createDecklinkIoRouterSchema.parse({ route_count: 0 })).toThrow();
  });
});
