import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createDirectDisplayOutputImpl,
  createDirectDisplayOutputSchema,
} from "../../src/tools/layer2/createDirectDisplayOutput.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("createDirectDisplayOutputImpl", () => {
  it("builds a Direct Display output scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "direct_display_output",
          container_path: "/project1/direct_display_output",
          nodes: { display_map: "/project1/direct_display_output/display_map" },
          warnings: [],
        });
      }),
    );

    const args = createDirectDisplayOutputSchema.parse({
      display_index: 1,
      output_count: 2,
      resolution_width: 2560,
      resolution_height: 1440,
    });
    const result = await createDirectDisplayOutputImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.display_index).toBe(1);
    expect(payload.nodes.find((node) => node.name === "direct_display")?.optype).toBe(
      "directdisplayoutTOP",
    );
    expect(payload.nodes.find((node) => node.name === "monitors")?.optype).toBe("monitorsDAT");
    expect(payload.nodes.find((node) => node.name === "display_map")?.table?.join(" ")).toContain(
      "2560x1440",
    );
    expect(capturedScript).toContain("nodeY");
    expect(capturedScript).toContain("_replace_unsupported_node");
    expect(textOf(result)).toContain("Created Direct Display output");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "direct_display_output", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await createDirectDisplayOutputImpl(
      makeCtx(),
      createDirectDisplayOutputSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("create_direct_display_output failed");
  });

  it("rejects unsupported Direct Display output counts", () => {
    expect(() => createDirectDisplayOutputSchema.parse({ output_count: 4 })).toThrow();
  });
});
