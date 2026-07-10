import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectMilluminShowImpl,
  connectMilluminShowSchema,
} from "../../src/tools/layer2/connectMilluminShow.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectMilluminShowImpl", () => {
  it("builds a Millumin show control scaffold payload", async () => {
    let capturedScript = "";

    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "millumin_show",
          container_path: "/project1/millumin_show",
          nodes: { command_map: "/project1/millumin_show/command_map" },
          warnings: [],
        });
      }),
    );

    const args = connectMilluminShowSchema.parse({
      millumin_host: "10.0.0.90",
      send_port: 5010,
      receive_port: 5011,
      layer_count: 3,
      column_count: 5,
      dashboard_page: "foh",
      active: true,
    });
    const result = await connectMilluminShowImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.kind).toBe("millumin_show");
    expect(payload.metadata.millumin_host).toBe("10.0.0.90");
    expect(payload.metadata.dashboard_page).toBe("foh");
    expect(payload.nodes.find((node) => node.name === "command_map")?.table?.join(" ")).toContain(
      "/millumin/columns/5/launch",
    );
    expect(capturedScript).toContain("nodeX");
    expect(textOf(result)).toContain("Created Millumin show scaffold");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "millumin_show", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectMilluminShowImpl(makeCtx(), connectMilluminShowSchema.parse({}));

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_millumin_show failed");
  });

  it("rejects invalid layer counts", () => {
    expect(() => connectMilluminShowSchema.parse({ layer_count: 0 })).toThrow();
  });
});
