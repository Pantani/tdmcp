import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import {
  addCustomParametersImpl,
  addCustomParametersSchema,
  buildParamsScript,
} from "../../src/tools/layer2/addCustomParameters.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

interface Payload {
  comp: string;
  page: string;
  params: Array<{
    name: string;
    type: string;
    default?: unknown;
    min?: number;
    max?: number;
    clamp?: boolean;
    menu_names?: string[];
  }>;
}

function decodePayload(script: string): Payload {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (b64 === undefined) throw new Error("no base64 payload in script");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
}

function fakeCtx(exec: ReturnType<typeof vi.fn>): ToolContext {
  return { client: { executePythonScript: exec }, logger: silentLogger } as unknown as ToolContext;
}

function scriptArg(exec: ReturnType<typeof vi.fn>): string {
  const s = exec.mock.calls[0]?.[0];
  if (typeof s !== "string") throw new Error("executePythonScript not called with a string");
  return s;
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

const okReport = (over: Record<string, unknown> = {}) =>
  vi.fn(async (_script: string, _capture?: boolean) => ({
    stdout: JSON.stringify({
      comp: "/project1/sys",
      page: "Custom",
      added: ["Speed", "Blur"],
      skipped: [],
      warnings: [],
      ...over,
    }),
  }));

const validArgs = (over: Record<string, unknown> = {}) =>
  addCustomParametersSchema.parse({
    comp_path: "/project1/sys",
    params: [
      { name: "Speed", type: "Float", default: 0.5, min: 0, max: 2 },
      { name: "Blur", type: "Int", default: 4, min: 0, max: 64, clamp: true },
    ],
    ...over,
  });

describe("buildParamsScript", () => {
  it("round-trips comp, page, and the params (with type/default/min/max)", () => {
    const script = buildParamsScript({
      comp: "/project1/sys",
      page: "Custom",
      params: [{ name: "Speed", type: "Float", default: 0.5, min: 0, max: 2, clamp: false }],
    });
    const payload = decodePayload(script);
    expect(payload.comp).toBe("/project1/sys");
    expect(payload.page).toBe("Custom");
    expect(payload.params[0]).toMatchObject({ name: "Speed", type: "Float", default: 0.5 });
  });

  it("emits the appendCustomPage + append* dispatch for every widget kind", () => {
    const script = buildParamsScript({ comp: "/c", page: "Custom", params: [] });
    expect(script).toContain("appendCustomPage");
    for (const fn of [
      "appendFloat",
      "appendInt",
      "appendToggle",
      "appendMenu",
      "appendStr",
      "appendPulse",
      "appendRGB",
      "appendXYZ",
    ]) {
      expect(script).toContain(fn);
    }
    // Menu sets its option lists; numeric pars set normMin/normMax + optional hard clamp.
    expect(script).toContain("menuNames");
    expect(script).toContain("normMin");
    expect(script).toContain("clampMin");
  });

  it("guards list defaults component-wise for the numeric AND XYZ branches", () => {
    const script = buildParamsScript({ comp: "/c", page: "Custom", params: [] });
    // A Float/Int (size > 1) or XYZ default may be an array; neither branch may assign
    // the whole list to one component, so both guard with isinstance(list/tuple).
    const guards = script.match(/isinstance\(_dflt, \(list, tuple\)\)/g) ?? [];
    expect(guards.length).toBeGreaterThanOrEqual(2);
  });

  it("parses string Toggle defaults instead of trusting bool() ('false'/'0' → False)", () => {
    const script = buildParamsScript({ comp: "/c", page: "Custom", params: [] });
    expect(script).toContain('("", "0", "false", "no", "off")');
  });
});

describe("addCustomParametersImpl", () => {
  it("auto-capitalizes the page name before sending it to TD", async () => {
    const exec = okReport({ page: "Controls" });
    await addCustomParametersImpl(fakeCtx(exec), validArgs({ page: "controls" }));
    expect(decodePayload(scriptArg(exec)).page).toBe("Controls");
    // It captures stdout (second arg true) so it can parse the JSON report back.
    expect(exec.mock.calls[0]?.[1]).toBe(true);
  });

  it("summarizes the added count, page, and comp on success", async () => {
    const result = await addCustomParametersImpl(fakeCtx(okReport()), validArgs());
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("Added 2 parameter(s)");
    expect(text).toContain("Custom");
    expect(text).toContain("/project1/sys");
  });

  it("treats a duplicate parameter as a skip + warning, not a failure", async () => {
    const exec = okReport({
      added: ["Blur"],
      skipped: ["Speed"],
      warnings: ["Parameter 'Speed' already exists on /project1/sys — skipped."],
    });
    const result = await addCustomParametersImpl(fakeCtx(exec), validArgs());
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("1 skipped");
    expect(text).toMatch(/1 warning\(s\)/);
  });

  it("returns an error result (not a throw) when report.fatal is set", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        comp: "/project1/sys",
        page: "Custom",
        added: [],
        skipped: [],
        warnings: [],
        fatal: "COMP not found: /project1/sys",
      }),
    }));
    const result = await addCustomParametersImpl(fakeCtx(exec), validArgs());
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("COMP not found");
  });

  it("never throws when the bridge call fails — it returns an isError result", async () => {
    const exec = vi.fn(async () => {
      throw new Error("connection refused");
    });
    const result = await addCustomParametersImpl(fakeCtx(exec), validArgs());
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connection refused");
  });
});

describe("addCustomParametersSchema (input validation)", () => {
  it("rejects an empty params array", () => {
    expect(addCustomParametersSchema.safeParse({ comp_path: "/c", params: [] }).success).toBe(
      false,
    );
  });

  it("rejects a missing comp_path", () => {
    expect(
      addCustomParametersSchema.safeParse({ params: [{ name: "X", type: "Float" }] }).success,
    ).toBe(false);
  });

  it("rejects an unknown parameter type", () => {
    expect(
      addCustomParametersSchema.safeParse({
        comp_path: "/c",
        params: [{ name: "X", type: "Banana" }],
      }).success,
    ).toBe(false);
  });

  it("defaults the page to 'Custom'", () => {
    const parsed = addCustomParametersSchema.parse({
      comp_path: "/c",
      params: [{ name: "X", type: "Float" }],
    });
    expect(parsed.page).toBe("Custom");
  });

  it("accepts an [r,g,b] / [x,y,z] array default for RGB and XYZ parameters", () => {
    const parsed = addCustomParametersSchema.safeParse({
      comp_path: "/c",
      params: [
        { name: "Tint", type: "RGB", default: [1, 0, 0] },
        { name: "Pos", type: "XYZ", default: [1, 2, 3] },
      ],
    });
    expect(parsed.success).toBe(true);
    // The vector default survives into the payload the bridge receives.
    if (parsed.success) {
      const payload = decodePayload(
        buildParamsScript({ comp: "/c", page: "Custom", params: parsed.data.params }),
      );
      expect(payload.params[0]?.default).toEqual([1, 0, 0]);
      expect(payload.params[1]?.default).toEqual([1, 2, 3]);
    }
  });
});
