import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectNotionShowRundownImpl,
  connectNotionShowRundownSchema,
} from "../../src/tools/layer2/connectNotionShowRundown.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectNotionShowRundownImpl", () => {
  it("builds a Notion show rundown scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "notion_show_rundown",
          container_path: "/project1/notion_show_rundown",
          nodes: { scene_map: "/project1/notion_show_rundown/scene_map" },
          warnings: [],
        });
      }),
    );

    const args = connectNotionShowRundownSchema.parse({
      rundown_label: "doors_show",
      scene_count: 4,
      property_count: 5,
    });
    const result = await connectNotionShowRundownImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.rundown_label).toBe("doors_show");
    expect(payload.nodes.find((node) => node.name === "notion_client")?.optype).toBe(
      "webclientDAT",
    );
    expect(payload.nodes.find((node) => node.name === "scene_map")?.table?.join(" ")).toContain(
      "scene_04",
    );
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created Notion show rundown");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "notion_show_rundown", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectNotionShowRundownImpl(
      makeCtx(),
      connectNotionShowRundownSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_notion_show_rundown failed");
  });

  it("rejects invalid scene counts", () => {
    expect(() => connectNotionShowRundownSchema.parse({ scene_count: 0 })).toThrow();
  });
});
