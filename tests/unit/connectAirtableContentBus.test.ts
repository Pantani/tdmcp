import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectAirtableContentBusImpl,
  connectAirtableContentBusSchema,
} from "../../src/tools/layer2/connectAirtableContentBus.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectAirtableContentBusImpl", () => {
  it("builds an Airtable content bus scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "airtable_content_bus",
          container_path: "/project1/airtable_content_bus",
          nodes: { record_map: "/project1/airtable_content_bus/record_map" },
          warnings: [],
        });
      }),
    );

    const args = connectAirtableContentBusSchema.parse({
      table_name: "Install Content",
      view_name: "Published",
      record_count: 5,
      field_count: 4,
    });
    const result = await connectAirtableContentBusImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.table_name).toBe("Install Content");
    expect(payload.nodes.find((node) => node.name === "airtable_client")?.optype).toBe(
      "webclientDAT",
    );
    expect(payload.nodes.find((node) => node.name === "record_map")?.table?.join(" ")).toContain(
      "rec_0005",
    );
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created Airtable content bus");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "airtable_content_bus", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectAirtableContentBusImpl(
      makeCtx(),
      connectAirtableContentBusSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_airtable_content_bus failed");
  });

  it("rejects invalid record counts", () => {
    expect(() => connectAirtableContentBusSchema.parse({ record_count: 0 })).toThrow();
  });
});
