import { describe, expect, it } from "vitest";
import { allowsCallerCode, genericNodeCodeBearingSources } from "../../src/tools/codeBearing.js";

describe("genericNodeCodeBearingSources", () => {
  it("detects executable operator types and DAT file sources", () => {
    expect(
      genericNodeCodeBearingSources("executeDAT", {
        file: "/tmp/payload.py",
        syncfile: 1,
        active: 1,
      }),
    ).toEqual(
      expect.arrayContaining(["operator type executeDAT", "parameter file", "parameter syncfile"]),
    );
    expect(genericNodeCodeBearingSources("scriptCHOP")).toContain("operator type scriptCHOP");
    expect(genericNodeCodeBearingSources("nullTOP", { callbacksDAT: "/project1/cb" })).toContain(
      "parameter callbacksDAT",
    );
  });

  it.each(["expressionCHOP", "evaluateDAT"])("detects executable operator type %s", (type) => {
    expect(genericNodeCodeBearingSources(type)).toContain(`operator type ${type}`);
  });

  it.each([
    ["selectDAT", { rowexpr: "__import__('os').system('id')" }, "parameter rowexpr"],
    ["baseCOMP", { ext0object: "op('/caller')" }, "parameter ext0object"],
    ["groupSOP", { filter: "caller expression" }, "parameter filter"],
    ["deleteSOP", { filter: "caller expression" }, "parameter filter"],
    ["textCOMP", { customformatting: "{__import__('os')}" }, "parameter customformatting"],
  ] as const)("detects code-bearing %s parameters", (type, parameters, source) => {
    expect(genericNodeCodeBearingSources(type, parameters)).toContain(source);
  });

  it("does not mistake ordinary constant parameter names for script source", () => {
    expect(
      genericNodeCodeBearingSources("baseCOMP", {
        description: "ambient layer",
        transcript: "spoken words",
      }),
    ).toEqual([]);
  });
});

describe("allowsCallerCode", () => {
  it("treats safe and directory profiles as restricted even when raw Python is on", () => {
    expect(allowsCallerCode({ allowRawPython: true, toolProfile: "safe" })).toBe(false);
    expect(allowsCallerCode({ allowRawPython: true, toolProfile: "directory" })).toBe(false);
    expect(allowsCallerCode({ allowRawPython: true, toolProfile: "full" })).toBe(true);
  });
});
