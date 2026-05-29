import { describe, expect, it } from "vitest";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Builder-3 isolation tests for `error_dat_log_capture`.
//
// The client `getLogs` method, the `BridgeLogsSchema` it validates against, and
// the `getBridgeLogs` tool rewire are SHARED files owned by the integrator. So
// this builder tests what it owns and the contract it must hand over:
//
//   1. The §4.6b response schemas (defined here verbatim) parse the canonical
//      GET /api/logs payload that td/log_endpoint.get_logs emits — both the
//      populated case and the {available:false} fallback case — proving the
//      Python keys agree with the schema so the client won't reject the shape.
//   2. The documented `getBridgeLogs` mapping (endpoint 6-col rows ->
//      {source:'cook', level, text, op}) as a pure transform, locking in the
//      field renames the integrator must apply (level<-severity, text<-message,
//      op<-source).
//
// The exec-fallback branch (fires on TdApiError or available:false) is a tool
// rewire; its behavioural test is documented for the integrator in the build note.
// ---------------------------------------------------------------------------

// --- §4.6b validator schemas (kept in lock-step with the design spec) --------
const BridgeLogLineSchema = z.object({
  source: z.string().default(""),
  message: z.string().default(""),
  absframe: z.number().int().optional(),
  frame: z.number().int().optional(),
  severity: z.string().default(""),
  type: z.string().default(""),
});
const BridgeLogsSchema = z.object({
  lines: z.array(BridgeLogLineSchema).default([]),
  count: z.number().int().default(0),
  error_dat: z.string().optional(),
  available: z.boolean().default(true),
  warnings: z.array(z.string()).default([]),
});

type BridgeLogLine = z.infer<typeof BridgeLogLineSchema>;

// The mapping getBridgeLogsImpl applies to endpoint rows when available:true.
// Encoded here as a pure transform so the field renames are asserted, not assumed.
function mapEndpointLine(line: BridgeLogLine): {
  source: string;
  level: string;
  text: string;
  op?: string;
} {
  return {
    source: "cook",
    level: line.severity,
    text: line.message,
    op: line.source || undefined,
  };
}

describe("GET /api/logs response schema (§4.6b)", () => {
  it("parses a populated Error-DAT payload (6-col rows)", () => {
    // Exactly what td/log_endpoint.get_logs returns when the Error DAT has rows.
    const payload = {
      lines: [
        {
          source: "/project1/movie1",
          message: "Failed to open file.",
          absframe: 45338,
          frame: 348,
          severity: "warning",
          type: "TOP",
        },
      ],
      count: 1,
      error_dat: "/project1/tdmcp_bridge/error_log",
      available: true,
      warnings: [],
    };
    const parsed = BridgeLogsSchema.parse(payload);
    expect(parsed.available).toBe(true);
    expect(parsed.count).toBe(1);
    const line = parsed.lines[0];
    expect(line?.source).toBe("/project1/movie1");
    expect(line?.severity).toBe("warning");
    expect(line?.absframe).toBe(45338);
  });

  it("parses the {available:false} fallback payload (older bridge / DAT missing)", () => {
    const payload = {
      lines: [],
      count: 0,
      error_dat: "/project1/tdmcp_bridge/error_log",
      available: false,
      warnings: ["Error DAT not found at /project1/tdmcp_bridge/error_log; reinstall the bridge."],
    };
    const parsed = BridgeLogsSchema.parse(payload);
    expect(parsed.available).toBe(false);
    expect(parsed.lines).toEqual([]);
    expect(parsed.warnings.length).toBe(1);
  });

  it("tolerates rows without absframe/frame (guarded int coercion left them out)", () => {
    const parsed = BridgeLogsSchema.parse({
      lines: [{ source: "/p/a", message: "boom", severity: "error", type: "CHOP" }],
      count: 1,
    });
    const line = parsed.lines[0];
    expect(line?.absframe).toBeUndefined();
    expect(line?.frame).toBeUndefined();
    expect(line?.severity).toBe("error");
  });

  it("defaults available to true and lines to [] for a minimal payload", () => {
    const parsed = BridgeLogsSchema.parse({});
    expect(parsed.available).toBe(true);
    expect(parsed.lines).toEqual([]);
    expect(parsed.count).toBe(0);
  });
});

describe("getBridgeLogs endpoint-row mapping (§4.6b)", () => {
  it("renames severity->level, message->text, source->op, and tags source='cook'", () => {
    const row = BridgeLogLineSchema.parse({
      source: "/project1/movie1",
      message: "Failed to open file.",
      absframe: 45338,
      frame: 348,
      severity: "warning",
      type: "TOP",
    });
    const mapped = mapEndpointLine(row);
    expect(mapped).toEqual({
      source: "cook",
      level: "warning",
      text: "Failed to open file.",
      op: "/project1/movie1",
    });
  });

  it("maps error-severity rows so error/warning counts can be derived", () => {
    const rows = [
      { source: "/p/a", message: "m1", severity: "error", type: "TOP" },
      { source: "/p/b", message: "m2", severity: "warning", type: "SOP" },
    ].map((r) => mapEndpointLine(BridgeLogLineSchema.parse(r)));
    expect(rows.filter((r) => r.level === "error")).toHaveLength(1);
    expect(rows.filter((r) => r.level === "warning")).toHaveLength(1);
    expect(rows.every((r) => r.source === "cook")).toBe(true);
  });

  it("omits op when the source column is blank", () => {
    const mapped = mapEndpointLine(
      BridgeLogLineSchema.parse({ message: "no source", severity: "error" }),
    );
    expect(mapped.op).toBeUndefined();
    expect(mapped.text).toBe("no source");
  });
});
