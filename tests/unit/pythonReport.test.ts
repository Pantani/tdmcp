import { describe, expect, it } from "vitest";
import { buildPayloadScript, parsePythonReport } from "../../src/tools/pythonReport.js";

describe("buildPayloadScript", () => {
  it("base64-embeds the payload at the placeholder", () => {
    const script = buildPayloadScript("x = '__PAYLOAD_B64__'", { a: 1, s: "hi" });
    const b64 = /x = '([^']+)'/.exec(script)?.[1] ?? "";
    expect(JSON.parse(Buffer.from(b64, "base64").toString("utf8"))).toEqual({ a: 1, s: "hi" });
  });
});

describe("parsePythonReport", () => {
  it("reads the report from the last line even when earlier TD logs carry stray braces", () => {
    // Regression: the old `first { … last }` span would splice the warning's
    // brace into the report and fail to parse. The report is the final line.
    const stdout = 'WARNING: cooked dict {\'a\': 1} on /project1\n{"ok": true, "value": 42}';
    expect(parsePythonReport<{ ok: boolean; value: number }>(stdout)).toEqual({
      ok: true,
      value: 42,
    });
  });

  it("falls back to the brace span for a report printed across multiple lines", () => {
    const stdout = '{\n  "ok": true,\n  "n": 3\n}';
    expect(parsePythonReport<{ ok: boolean; n: number }>(stdout)).toEqual({ ok: true, n: 3 });
  });

  it("ignores trailing blank lines", () => {
    expect(parsePythonReport<{ k: number }>('{"k": 5}\n\n  \n')).toEqual({ k: 5 });
  });

  it("throws a friendly error when there is no output", () => {
    expect(() => parsePythonReport(undefined)).toThrow(/no output/);
    expect(() => parsePythonReport("")).toThrow(/no output/);
  });

  it("throws a friendly error (not a raw SyntaxError) on unparseable output", () => {
    expect(() => parsePythonReport("garbage {not: json}")).toThrow(/Could not parse/);
    expect(() => parsePythonReport("no json at all")).toThrow(/Could not parse/);
  });
});
