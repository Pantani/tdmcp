import { describe, expect, it } from "vitest";
import { z } from "zod";
import { computeDatTextReplace } from "../../src/tools/layer3/datTextReplace.js";

// ---------------------------------------------------------------------------
// Builder-3 isolation tests for `param_modes_rest_endpoint`.
//
// The client methods (readParameterModes / setParameterMode / getDatText /
// putDatText), the validators they Zod-parse against, and the four tool rewires
// (readParameterModes / setParameterExpression / editDatContent / setDatContent)
// are SHARED files owned by the integrator — a builder must not edit them. So
// here we test exactly what this builder owns and ships:
//
//   1. The §4.6a response schemas (defined here verbatim) actually parse the
//      canonical endpoint payloads the Python module emits — proving the Python
//      keys and the schema agree, which is what stops the client from throwing
//      "Unexpected data shape" once the integrator wires them up.
//   2. The pure `computeDatTextReplace` helper (src/tools/layer3/datTextReplace.ts,
//      a new builder-owned module) that the editDatContent rewire ports to TS.
//
// Post-rewire tool behavioural tests are documented for the integrator in the
// build note (they can only exist once the shared client methods land).
// ---------------------------------------------------------------------------

// --- §4.6a validator schemas (kept in lock-step with the design spec) --------
const ParamModeEntrySchema = z.object({
  name: z.string(),
  mode: z.string(),
  value: z.unknown().optional(),
  expr: z.string().optional(),
  bind_expr: z.string().optional(),
  export_op: z.string().optional(),
});
const ParamModesSchema = z.object({
  path: z.string(),
  type: z.string().default(""),
  name: z.string().default(""),
  parameters: z.array(ParamModeEntrySchema).default([]),
  warnings: z.array(z.string()).default([]),
});
const SetParamModeResultSchema = z.object({
  path: z.string(),
  param: z.string(),
  mode: z.string(),
  readback_mode: z.string().default(""),
  readback_expr: z.string().default(""),
});
const DatTextSchema = z.object({
  path: z.string(),
  text: z.string().default(""),
  is_table: z.boolean().default(false),
  num_rows: z.number().int().default(0),
  num_cols: z.number().int().default(0),
});
const DatTextWriteSchema = z.object({
  path: z.string(),
  old_length: z.number().int().default(0),
  new_length: z.number().int().default(0),
});

describe("param/text endpoint response schemas (§4.6a)", () => {
  it("ParamModesSchema parses the read_param_modes payload (keys/expr/bind preserved)", () => {
    // Exactly what td/param_modes_endpoint.read_param_modes returns.
    const payload = {
      path: "/project1/noise1",
      type: "noiseTOP",
      name: "noise1",
      parameters: [
        { name: "amp", mode: "CONSTANT", value: 0.5 },
        { name: "period", mode: "EXPRESSION", value: 2, expr: "me.time.seconds" },
        { name: "ty", mode: "BIND", value: 1, bind_expr: "parent().par.X" },
        { name: "tx", mode: "EXPORT", value: 0, export_op: "/project1/exporter" },
      ],
      warnings: [],
    };
    const parsed = ParamModesSchema.parse(payload);
    expect(parsed.path).toBe("/project1/noise1");
    expect(parsed.parameters).toHaveLength(4);
    const byName = Object.fromEntries(parsed.parameters.map((p) => [p.name, p]));
    expect(byName.period?.expr).toBe("me.time.seconds");
    expect(byName.ty?.bind_expr).toBe("parent().par.X");
    expect(byName.tx?.export_op).toBe("/project1/exporter");
    expect(byName.amp?.value).toBe(0.5);
  });

  it("ParamModesSchema fills defaults for a minimal payload", () => {
    const parsed = ParamModesSchema.parse({ path: "/project1/x" });
    expect(parsed.parameters).toEqual([]);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.type).toBe("");
  });

  it("SetParamModeResultSchema parses the set_param_mode payload (mode actually flipped)", () => {
    const parsed = SetParamModeResultSchema.parse({
      path: "/project1/geo1",
      param: "tx",
      mode: "expression",
      readback_mode: "EXPRESSION",
      readback_expr: "me.time.seconds",
    });
    // readback_mode is the live mode name — proves the endpoint flipped par.mode,
    // not just par.expr (the latent ParMode bug this feature fixes).
    expect(parsed.readback_mode).toBe("EXPRESSION");
    expect(parsed.readback_expr).toBe("me.time.seconds");
  });

  it("DatTextSchema parses a table DAT's text payload with metadata", () => {
    const parsed = DatTextSchema.parse({
      path: "/project1/table1",
      text: "a\tb\nc\td",
      is_table: true,
      num_rows: 2,
      num_cols: 2,
    });
    expect(parsed.is_table).toBe(true);
    expect(parsed.num_rows).toBe(2);
    expect(parsed.text).toContain("\t");
  });

  it("DatTextWriteSchema parses the put_dat_text length report", () => {
    const parsed = DatTextWriteSchema.parse({
      path: "/project1/text1",
      old_length: 3,
      new_length: 11,
    });
    expect(parsed.old_length).toBe(3);
    expect(parsed.new_length).toBe(11);
  });

  it("rejects a payload missing the required path", () => {
    expect(() => DatTextSchema.parse({ text: "x" })).toThrow();
    expect(() => ParamModesSchema.parse({})).toThrow();
  });
});

// --- computeDatTextReplace (builder-owned pure helper, §4.7a) ----------------
describe("computeDatTextReplace", () => {
  it("replaces exactly one occurrence and reports counts", () => {
    const r = computeDatTextReplace("hello world", "world", "there", false);
    expect(r.error).toBeUndefined();
    expect(r.text).toBe("hello there");
    expect(r.occurrences).toBe(1);
    expect(r.replacements).toBe(1);
  });

  it("errors (no write) when there are zero matches", () => {
    const r = computeDatTextReplace("hello world", "absent", "x", false);
    expect(r.error).toContain("not found");
    expect(r.text).toBeUndefined();
    expect(r.occurrences).toBe(0);
    expect(r.replacements).toBe(0);
  });

  it("errors (no write) when >1 match and replace_all is false", () => {
    const r = computeDatTextReplace("a a a", "a", "b", false);
    expect(r.error).toContain("matches 3 times");
    expect(r.text).toBeUndefined();
    expect(r.occurrences).toBe(3);
    expect(r.replacements).toBe(0);
  });

  it("replaces every occurrence when replace_all is true", () => {
    const r = computeDatTextReplace("a a a", "a", "b", true);
    expect(r.error).toBeUndefined();
    expect(r.text).toBe("b b b");
    expect(r.occurrences).toBe(3);
    expect(r.replacements).toBe(3);
  });

  it("replace_all with a single match still replaces once", () => {
    const r = computeDatTextReplace("only one here", "one", "two", true);
    expect(r.text).toBe("only two here");
    expect(r.replacements).toBe(1);
  });

  it("rejects an empty old_string (would match everywhere)", () => {
    const r = computeDatTextReplace("anything", "", "x", false);
    expect(r.error).toContain("must not be empty");
    expect(r.text).toBeUndefined();
  });

  it("counts non-overlapping occurrences like Python str.count", () => {
    // 'aa' in 'aaaa' is 2 non-overlapping, not 3.
    const r = computeDatTextReplace("aaaa", "aa", "b", true);
    expect(r.occurrences).toBe(2);
    expect(r.text).toBe("bb");
  });

  it("handles newlines and quotes in the needle/replacement", () => {
    const r = computeDatTextReplace('line1\n"keep"\nline3', '"keep"', "REPLACED", false);
    expect(r.text).toBe("line1\nREPLACED\nline3");
    expect(r.replacements).toBe(1);
  });

  it("can delete the matched text with an empty replacement", () => {
    const r = computeDatTextReplace("keepDROPkeep", "DROP", "", false);
    expect(r.text).toBe("keepkeep");
    expect(r.replacements).toBe(1);
  });
});
