import { z } from "zod";
import { guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const getDatContentSchema = z.object({
  dat_path: z
    .string()
    .describe("Absolute path to the Text or Table DAT to read (e.g. '/project1/table1')."),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe(
      "First data-row index to return (0-based). For a table DAT it indexes data rows " +
        "(after the header when include_header is true); for a non-table Text DAT it indexes lines.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .default(100)
    .describe("Max rows/lines to return. Capped so a large table never floods context."),
  preview_rows: z
    .number()
    .int()
    .min(0)
    .max(50)
    .default(0)
    .describe(
      "If > 0, ALSO return the first N rows regardless of offset — a stable head preview " +
        "alongside a deep page. 0 disables the separate preview.",
    ),
  include_header: z
    .boolean()
    .default(true)
    .describe(
      "For table DATs, treat row 0 as a header: return it in `header` and make offset/limit " +
        "index the data rows after it. Set false to treat every row as data.",
    ),
});
type GetDatContentArgs = z.infer<typeof getDatContentSchema>;

interface RowRange {
  start: number;
  end: number;
}

interface GetDatContentReport {
  dat: string;
  is_table: boolean;
  num_rows: number;
  num_cols: number;
  header?: string[];
  rows: string[][] | string[];
  offset: number;
  limit: number;
  returned: number;
  row_range?: RowRange;
  preview?: string[][] | string[];
  truncated: boolean;
}

// PROBE-LIVE RISK (flag for QA): TD Table DAT `.text` is serialized as `\n`-separated
// rows and `\t`-separated cells. If any cell contains an embedded tab or newline this
// client-side split is LOSSY — a structural bridge read (P2-3, `.cells`/[row,col]) would
// be needed. v1 does not attempt to solve this; QA must probe a Table DAT with embedded
// tabs/newlines-in-cells before relying on the split.
//
// TD 099 serializes Table DAT `.text` with CRLF (`\r\n`) row terminators, so we normalize
// on `/\r?\n/` and strip any stray lone `\r` so no `\r` survives in an emitted cell — a CRLF
// file and an LF file with the same logical rows produce identical output.
function splitLines(text: string): string[] {
  if (!text.length) return [];
  return text
    .replace(/\r?\n$/, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\r|\r$/g, ""));
}

function pageIsPartial(offset: number, pageLen: number, total: number): boolean {
  return offset > 0 || offset + pageLen < total;
}

function sliceTable(dat: TdDatText, args: GetDatContentArgs): GetDatContentReport {
  const grid = splitLines(dat.text).map((line) => line.split("\t"));
  const header = args.include_header ? grid[0] : undefined;
  const body = args.include_header ? grid.slice(1) : grid;
  const page = body.slice(args.offset, args.offset + args.limit);
  const partial = pageIsPartial(args.offset, page.length, body.length);
  return {
    dat: dat.path,
    is_table: true,
    num_rows: dat.num_rows,
    num_cols: dat.num_cols,
    header,
    rows: page,
    offset: args.offset,
    limit: args.limit,
    returned: page.length,
    row_range: partial ? { start: args.offset, end: args.offset + page.length } : undefined,
    preview: args.preview_rows > 0 ? body.slice(0, args.preview_rows) : undefined,
    truncated: page.length < body.length,
  };
}

function sliceText(dat: TdDatText, args: GetDatContentArgs): GetDatContentReport {
  const lines = splitLines(dat.text);
  const page = lines.slice(args.offset, args.offset + args.limit);
  const partial = pageIsPartial(args.offset, page.length, lines.length);
  return {
    dat: dat.path,
    is_table: false,
    num_rows: dat.num_rows,
    num_cols: dat.num_cols,
    rows: page,
    offset: args.offset,
    limit: args.limit,
    returned: page.length,
    row_range: partial ? { start: args.offset, end: args.offset + page.length } : undefined,
    preview: args.preview_rows > 0 ? lines.slice(0, args.preview_rows) : undefined,
    truncated: page.length < lines.length,
  };
}

// Minimal shape of the bridge `/text` envelope this tool consumes.
interface TdDatText {
  path: string;
  text: string;
  is_table: boolean;
  num_rows: number;
  num_cols: number;
}

export async function getDatContentImpl(ctx: ToolContext, args: GetDatContentArgs) {
  return guardTd(
    async () => {
      const dat = await ctx.client.getDatText(args.dat_path);
      return dat.is_table ? sliceTable(dat, args) : sliceText(dat, args);
    },
    (report) => {
      const total = report.is_table ? report.num_rows : "?";
      return jsonResult(`Read ${report.returned}/${total} row(s) from ${report.dat}.`, report);
    },
  );
}

export const registerGetDatContent: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "get_dat_content",
    {
      title: "Read DAT content (paginated)",
      description:
        "Read a Text or Table DAT with pagination so a large table cannot flood context. " +
        "Returns total row/col counts, a header (table DATs), a sliced page (offset/limit), " +
        "an optional stable head preview (preview_rows), and a `row_range` only on a partial read. " +
        "Table DATs are split on tabs/newlines client-side — that split is lossy if a cell embeds " +
        "a literal tab or newline (probe live before relying on it). Use edit_dat_content/set_dat_content to write.",
      inputSchema: getDatContentSchema.shape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => getDatContentImpl(ctx, args),
  );
};
