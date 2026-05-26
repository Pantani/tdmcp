import { describe, expect, it } from "vitest";
import { buildPanelScript, parseReport } from "../../src/tools/layer2/createControlPanel.js";

/** Decodes the base64 payload the generated script embeds, so tests can assert on it. */
function decodePayload(script: string): unknown {
  const match = /b64decode\("([^"]+)"\)/.exec(script);
  if (!match) throw new Error("script did not embed a base64 payload");
  return JSON.parse(Buffer.from(match[1], "base64").toString("utf8"));
}

describe("buildPanelScript", () => {
  it("round-trips the payload through the embedded base64 blob", () => {
    const payload = {
      comp: "/project1/sys",
      page: "Controls",
      controls: [
        { name: "blur amount", type: "float", min: 0, max: 50, default: 12, bind_to: ["/project1/sys/blur1.size"] },
        { name: "Enable", type: "toggle", default: true },
      ],
    };
    expect(decodePayload(buildPanelScript(payload))).toEqual(payload);
  });

  it("survives values that would break naive quoting (quotes, newlines, unicode)", () => {
    const payload = {
      comp: "/project1/sys",
      page: 'Tricky "Page"',
      controls: [{ name: "line1\nline2 'quoted' ★", type: "string", default: '}{")' }],
    };
    expect(decodePayload(buildPanelScript(payload))).toEqual(payload);
  });

  it("emits the custom-page + expression-binding machinery", () => {
    const script = buildPanelScript({ comp: "/p", page: "Controls", controls: [] });
    expect(script).toContain("appendCustomPage");
    expect(script).toContain("appendFloat");
    // Binding switches the target into expression mode via the enum derived from a live par.
    expect(script).toContain("_PM = type(_tp.mode)");
    expect(script).toContain("_tp.mode = _PM.EXPRESSION");
    expect(script).toContain("print(json.dumps(report))");
  });
});

describe("parseReport", () => {
  it("extracts the JSON object even with surrounding noise", () => {
    const stdout = `some TD log line\n{"comp":"/p","page":"Controls","created":[],"bound":[],"warnings":[]}\n`;
    const report = parseReport(stdout);
    expect(report.comp).toBe("/p");
    expect(report.created).toEqual([]);
  });

  it("throws when the script produced no output", () => {
    expect(() => parseReport(undefined)).toThrow();
    expect(() => parseReport("")).toThrow();
  });

  it("throws when no JSON object is present", () => {
    expect(() => parseReport("no json here")).toThrow();
  });
});
