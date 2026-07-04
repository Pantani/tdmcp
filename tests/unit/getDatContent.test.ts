import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { getDatContentImpl, getDatContentSchema } from "../../src/tools/layer3/getDatContent.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

const server = makeTdServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function makeCtx(): ToolContext {
  return {
    client: new TouchDesignerClient({ baseUrl: TD_BASE, timeoutMs: 2000 }),
    knowledge: new KnowledgeBase(),
    recipes: new RecipeLibrary(),
    logger: silentLogger,
  };
}

// A 1-header + 3-data-row table serialized the TD way (\n rows, \t cells).
const TABLE_TEXT = "h1\th2\nr1a\tr1b\nr2a\tr2b\nr3a\tr3b";

/** Override the default 404 on /text with a table DAT envelope. */
function mockTableDat(): void {
  server.use(
    http.get(`${TD_BASE}/api/nodes/:seg/text`, () =>
      HttpResponse.json({
        ok: true,
        data: {
          path: "/project1/table1",
          text: TABLE_TEXT,
          is_table: true,
          num_rows: 4,
          num_cols: 2,
        },
      }),
    ),
  );
}

// The same logical table serialized the TD-099 way: CRLF (\r\n) row terminators.
// Multi-column rows exercise the last-cell case where a lone \r would otherwise survive.
const TABLE_TEXT_CRLF = "h1\th2\r\nr1a\tr1b\r\nr2a\tr2b\r\nr3a\tr3b";

/** Override the default 404 on /text with a CRLF-serialized table DAT envelope. */
function mockTableDatCrlf(): void {
  server.use(
    http.get(`${TD_BASE}/api/nodes/:seg/text`, () =>
      HttpResponse.json({
        ok: true,
        data: {
          path: "/project1/table1",
          text: TABLE_TEXT_CRLF,
          is_table: true,
          num_rows: 4,
          num_cols: 2,
        },
      }),
    ),
  );
}

function mockTextDat(text: string): void {
  server.use(
    http.get(`${TD_BASE}/api/nodes/:seg/text`, () =>
      HttpResponse.json({
        ok: true,
        data: { path: "/project1/text1", text, is_table: false, num_rows: 0, num_cols: 0 },
      }),
    ),
  );
}

// The impl arg type requires the defaulted fields; parse to fill them exactly as a real call.
function parseArgs(partial: Record<string, unknown>) {
  return getDatContentSchema.parse(partial);
}

describe("get_dat_content", () => {
  describe("schema defaults", () => {
    it("fills offset/limit/preview_rows/include_header", () => {
      const parsed = getDatContentSchema.parse({ dat_path: "/x" });
      expect(parsed).toMatchObject({
        offset: 0,
        limit: 100,
        preview_rows: 0,
        include_header: true,
      });
    });

    it("rejects a negative offset and a limit over 1000", () => {
      expect(() => getDatContentSchema.parse({ dat_path: "/x", offset: -1 })).toThrow();
      expect(() => getDatContentSchema.parse({ dat_path: "/x", limit: 1001 })).toThrow();
    });
  });

  describe("table DAT", () => {
    it("surfaces total row/col counts from the bridge envelope", async () => {
      mockTableDat();
      const result = await getDatContentImpl(
        makeCtx(),
        parseArgs({ dat_path: "/project1/table1" }),
      );
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toBeUndefined();
      const report = decodeReport(result);
      expect(report.num_rows).toBe(4);
      expect(report.num_cols).toBe(2);
    });

    it("splits the header and excludes it from data rows by default", async () => {
      mockTableDat();
      const result = await getDatContentImpl(
        makeCtx(),
        parseArgs({ dat_path: "/project1/table1" }),
      );
      const report = decodeReport(result);
      expect(report.header).toEqual(["h1", "h2"]);
      expect(report.rows).toEqual([
        ["r1a", "r1b"],
        ["r2a", "r2b"],
        ["r3a", "r3b"],
      ]);
    });

    it("treats every row as data when include_header is false", async () => {
      mockTableDat();
      const result = await getDatContentImpl(
        makeCtx(),
        parseArgs({ dat_path: "/project1/table1", include_header: false }),
      );
      const report = decodeReport(result);
      expect(report.header).toBeUndefined();
      expect(report.rows).toHaveLength(4);
      expect(report.rows[0]).toEqual(["h1", "h2"]);
    });

    it("paginates with offset/limit and emits row_range only when partial", async () => {
      mockTableDat();
      const result = await getDatContentImpl(
        makeCtx(),
        parseArgs({ dat_path: "/project1/table1", offset: 1, limit: 1 }),
      );
      const report = decodeReport(result);
      expect(report.rows).toEqual([["r2a", "r2b"]]);
      expect(report.returned).toBe(1);
      expect(report.row_range).toEqual({ start: 1, end: 2 });
      expect(report.truncated).toBe(true);
    });

    it("omits row_range and truncated on a full read from offset 0", async () => {
      mockTableDat();
      const result = await getDatContentImpl(
        makeCtx(),
        parseArgs({ dat_path: "/project1/table1", limit: 100 }),
      );
      const report = decodeReport(result);
      expect(report.row_range).toBeUndefined();
      expect(report.truncated).toBe(false);
      expect(report.returned).toBe(3);
    });

    it("returns a head preview independent of the deep page offset", async () => {
      mockTableDat();
      const result = await getDatContentImpl(
        makeCtx(),
        parseArgs({ dat_path: "/project1/table1", offset: 2, preview_rows: 1 }),
      );
      const report = decodeReport(result);
      // Deep page starts at data row 2 (0-based).
      expect(report.rows).toEqual([["r3a", "r3b"]]);
      // Preview is the FIRST data row regardless of offset.
      expect(report.preview).toEqual([["r1a", "r1b"]]);
    });
  });

  describe("CRLF row terminators (TD 099 regression)", () => {
    const noCarriageReturn = (rows: string[][] | string[]) =>
      rows.every((row) =>
        Array.isArray(row) ? row.every((cell) => !cell.includes("\r")) : !row.includes("\r"),
      );

    it("strips \\r from every cell, including the last column of every row", async () => {
      mockTableDatCrlf();
      const result = await getDatContentImpl(
        makeCtx(),
        parseArgs({ dat_path: "/project1/table1", preview_rows: 1 }),
      );
      const report = decodeReport(result);
      // Identical to the LF serialization — no stray \r anywhere.
      expect(report.header).toEqual(["h1", "h2"]);
      expect(report.rows).toEqual([
        ["r1a", "r1b"],
        ["r2a", "r2b"],
        ["r3a", "r3b"],
      ]);
      expect(report.header && noCarriageReturn(report.header)).toBe(true);
      expect(noCarriageReturn(report.rows)).toBe(true);
      expect(report.preview && noCarriageReturn(report.preview)).toBe(true);
    });

    it("keeps row/col counts and pagination identical to the LF serialization", async () => {
      mockTableDatCrlf();
      const result = await getDatContentImpl(
        makeCtx(),
        parseArgs({ dat_path: "/project1/table1", offset: 1, limit: 1 }),
      );
      const report = decodeReport(result);
      expect(report.num_rows).toBe(4);
      expect(report.num_cols).toBe(2);
      expect(report.returned).toBe(1);
      expect(report.rows).toEqual([["r2a", "r2b"]]);
      expect(report.row_range).toEqual({ start: 1, end: 2 });
      expect(report.truncated).toBe(true);
    });
  });

  describe("text DAT branch", () => {
    it("returns lines (not cells) and no header/preview by default", async () => {
      mockTextDat("line0\nline1\nline2\nline3");
      const result = await getDatContentImpl(
        makeCtx(),
        parseArgs({ dat_path: "/project1/text1", offset: 1, limit: 2 }),
      );
      const report = decodeReport(result);
      expect(report.is_table).toBe(false);
      expect(report.header).toBeUndefined();
      expect(report.rows).toEqual(["line1", "line2"]);
      expect(report.row_range).toEqual({ start: 1, end: 3 });
      expect(report.truncated).toBe(true);
    });
  });

  describe("error surfacing", () => {
    it("returns isError (friendly) and does not throw when the DAT is not found", async () => {
      server.use(
        http.get(`${TD_BASE}/api/nodes/:seg/text`, () =>
          HttpResponse.json(
            { ok: false, error: { message: "DAT not found: /project1/nope" } },
            { status: 404 },
          ),
        ),
      );
      const result = await getDatContentImpl(makeCtx(), parseArgs({ dat_path: "/project1/nope" }));
      expect(result.isError).toBe(true);
    });

    it("returns isError when the bridge is offline", async () => {
      server.use(http.get(`${TD_BASE}/api/nodes/:seg/text`, () => HttpResponse.error()));
      const result = await getDatContentImpl(
        makeCtx(),
        parseArgs({ dat_path: "/project1/table1" }),
      );
      expect(result.isError).toBe(true);
    });
  });
});

interface DecodedReport {
  dat: string;
  is_table: boolean;
  num_rows: number;
  num_cols: number;
  header?: string[];
  rows: string[][] | string[];
  offset: number;
  limit: number;
  returned: number;
  row_range?: { start: number; end: number };
  preview?: string[][] | string[];
  truncated: boolean;
}

/** jsonResult embeds the report in a ```json fence — pull it back out for assertions. */
function decodeReport(result: { content: Array<{ type: string; text?: string }> }): DecodedReport {
  const text = result.content.find((c) => c.type === "text")?.text ?? "";
  const m = /```json\n([\s\S]*?)\n```/.exec(text);
  if (!m?.[1]) throw new Error(`no json fence in result: ${text}`);
  return JSON.parse(m[1]) as DecodedReport;
}
