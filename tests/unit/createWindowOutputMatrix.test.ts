import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createWindowOutputMatrixImpl,
  createWindowOutputMatrixSchema,
} from "../../src/tools/layer2/createWindowOutputMatrix.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("createWindowOutputMatrixImpl", () => {
  it("builds a Window output matrix scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "window_output_matrix",
          container_path: "/project1/window_output_matrix",
          nodes: { window_map: "/project1/window_output_matrix/window_map" },
          warnings: [],
        });
      }),
    );

    const args = createWindowOutputMatrixSchema.parse({
      window_count: 3,
      resolution_width: 1280,
      resolution_height: 720,
      perform_mode: true,
    });
    const result = await createWindowOutputMatrixImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.perform_mode).toBe(true);
    const windowNodes = payload.nodes.filter((node) => node.optype === "windowCOMP");
    expect(windowNodes).toHaveLength(3);
    expect(windowNodes.map((node) => node.name)).toEqual(["window_1", "window_2", "window_3"]);
    expect(payload.nodes.find((node) => node.name === "window_map")?.table?.join(" ")).toContain(
      "window_3",
    );
    expect(payload.nodes.find((node) => node.name === "source_map")?.table?.join(" ")).toContain(
      "source_3",
    );
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created Window output matrix");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "window_output_matrix", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await createWindowOutputMatrixImpl(
      makeCtx(),
      createWindowOutputMatrixSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("create_window_output_matrix failed");
  });

  it("rejects invalid window counts", () => {
    expect(() => createWindowOutputMatrixSchema.parse({ window_count: 0 })).toThrow();
  });
});
