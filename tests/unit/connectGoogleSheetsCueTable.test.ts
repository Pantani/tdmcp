import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectGoogleSheetsCueTableImpl,
  connectGoogleSheetsCueTableSchema,
} from "../../src/tools/layer2/connectGoogleSheetsCueTable.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectGoogleSheetsCueTableImpl", () => {
  it("builds a Google Sheets cue table scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "google_sheets_cue_table",
          container_path: "/project1/google_sheets_cue_table",
          nodes: { cue_table: "/project1/google_sheets_cue_table/cue_table" },
          warnings: [],
        });
      }),
    );

    const args = connectGoogleSheetsCueTableSchema.parse({
      worksheet_name: "festival_cues",
      cue_count: 3,
      column_count: 7,
    });
    const result = await connectGoogleSheetsCueTableImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.worksheet_name).toBe("festival_cues");
    expect(payload.nodes.find((node) => node.name === "sheets_csv_client")?.optype).toBe(
      "webclientDAT",
    );
    expect(payload.nodes.find((node) => node.name === "cue_table")?.table?.join(" ")).toContain(
      "cue_003",
    );
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created Google Sheets cue table");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "google_sheets_cue_table", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectGoogleSheetsCueTableImpl(
      makeCtx(),
      connectGoogleSheetsCueTableSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_google_sheets_cue_table failed");
  });

  it("rejects invalid cue counts", () => {
    expect(() => connectGoogleSheetsCueTableSchema.parse({ cue_count: 0 })).toThrow();
  });
});
