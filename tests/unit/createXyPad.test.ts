import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import {
  buildXyPadScript,
  createXyPadImpl,
  createXyPadSchema,
} from "../../src/tools/layer2/createXyPad.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Payload {
  parent_path: string;
  name: string;
  x_target: string;
  y_target: string;
  z_target: string;
  x_range: number[];
  y_range: number[];
  z_range: number[];
  size: number;
}

function decodePayload(script: string): Payload {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (b64 === undefined) throw new Error("no base64 payload found in script");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as Payload;
}

function fakeCtx(exec: ReturnType<typeof vi.fn>): ToolContext {
  return {
    client: { executePythonScript: exec },
    logger: silentLogger,
  } as unknown as ToolContext;
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

/** Every defaulted field is required by the inferred impl arg type. */
const baseArgs: Parameters<typeof createXyPadImpl>[1] = {
  parent_path: "/project1",
  name: "xy_pad",
  x_target: "",
  y_target: "",
  z_target: "",
  x_range: [0, 1],
  y_range: [0, 1],
  z_range: [0, 1],
  label_x: "X",
  label_y: "Y",
  size: 400,
};

/** A representative success report the Python pass would emit. */
function happyReport(
  overrides: Partial<{
    z_slider: string | null;
    channels: string[];
    bound: string[];
    warnings: string[];
  }> = {},
) {
  return JSON.stringify({
    container: "/project1/xy_pad",
    xy_chop: "/project1/xy_pad/xy_pad_xy",
    panel_chop: "/project1/xy_pad/xy_pad_panel",
    z_slider: overrides.z_slider ?? null,
    channels: overrides.channels ?? ["u", "v"],
    bound: overrides.bound ?? [],
    warnings: overrides.warnings ?? [],
  });
}

// ---------------------------------------------------------------------------
// buildXyPadScript — pure, no TD needed
// ---------------------------------------------------------------------------

describe("buildXyPadScript (pure payload)", () => {
  it("embeds the schema fields in the base64 payload", () => {
    const script = buildXyPadScript({
      parent_path: "/project1",
      name: "xy_pad",
      x_target: "",
      y_target: "",
      z_target: "",
      x_range: [0, 1],
      y_range: [0, 1],
      z_range: [0, 1],
      size: 400,
    });
    const payload = decodePayload(script);
    expect(payload.parent_path).toBe("/project1");
    expect(payload.name).toBe("xy_pad");
    expect(payload.x_range).toEqual([0, 1]);
    expect(payload.size).toBe(400);
  });

  it("embeds axis targets and ranges when provided", () => {
    const script = buildXyPadScript({
      parent_path: "/project1",
      name: "pad",
      x_target: "geo1/transform1.tx",
      y_target: "geo1/transform1.ty",
      z_target: "geo1/transform1.tz",
      x_range: [-2, 2],
      y_range: [-1, 1],
      z_range: [0, 10],
      size: 512,
    });
    const payload = decodePayload(script);
    expect(payload.x_target).toBe("geo1/transform1.tx");
    expect(payload.y_target).toBe("geo1/transform1.ty");
    expect(payload.z_target).toBe("geo1/transform1.tz");
    expect(payload.x_range).toEqual([-2, 2]);
    expect(payload.z_range).toEqual([0, 10]);
    expect(payload.size).toBe(512);
  });

  it("passes a tricky target only inside the base64 blob (no raw interpolation)", () => {
    const tricky = "geo1/UNIQUEMARKER_xyzzy.tx";
    const script = buildXyPadScript({
      parent_path: "/project1",
      name: "pad",
      x_target: tricky,
      y_target: "",
      z_target: "",
      x_range: [0, 1],
      y_range: [0, 1],
      z_range: [0, 1],
      size: 400,
    });
    const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1] ?? "";
    expect(b64.length).toBeGreaterThan(0);
    const decoded = Buffer.from(b64, "base64").toString("utf8");
    expect(decoded).toContain(tricky);
    const templateWithoutBlob = script.replace(b64, "REDACTED");
    expect(templateWithoutBlob).not.toContain("UNIQUEMARKER_xyzzy");
  });

  it("script imports json/base64 and prints json.dumps(report), using the panel chain", () => {
    const script = buildXyPadScript({
      parent_path: "/project1",
      name: "pad",
      x_target: "",
      y_target: "",
      z_target: "",
      x_range: [0, 1],
      y_range: [0, 1],
      z_range: [0, 1],
      size: 400,
    });
    expect(script).toContain("import json, base64");
    expect(script).toContain("print(json.dumps(report))");
    expect(script).toContain("containerCOMP");
    expect(script).toContain("panelCHOP");
    expect(script).toContain("renameCHOP");
    expect(script).toContain("nullCHOP");
    expect(script).toContain("sliderCOMP");
  });
});

// ---------------------------------------------------------------------------
// Schema defaults
// ---------------------------------------------------------------------------

describe("createXyPadSchema defaults", () => {
  it("applies all documented defaults", () => {
    const parsed = createXyPadSchema.parse({});
    expect(parsed.parent_path).toBe("/project1");
    expect(parsed.name).toBe("xy_pad");
    expect(parsed.x_target).toBe("");
    expect(parsed.y_target).toBe("");
    expect(parsed.z_target).toBe("");
    expect(parsed.x_range).toEqual([0, 1]);
    expect(parsed.y_range).toEqual([0, 1]);
    expect(parsed.z_range).toEqual([0, 1]);
    expect(parsed.label_x).toBe("X");
    expect(parsed.label_y).toBe("Y");
    expect(parsed.size).toBe(400);
  });

  it("coerces a numeric string for size", () => {
    const parsed = createXyPadSchema.parse({ size: "256" });
    expect(parsed.size).toBe(256);
  });

  it("rejects degenerate pad sizes", () => {
    expect(() => createXyPadSchema.parse({ size: 0 })).toThrow();
    expect(() => createXyPadSchema.parse({ size: -1 })).toThrow();
  });

  it("rejects a range that is not length 2", () => {
    expect(() => createXyPadSchema.parse({ x_range: [0] })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Happy path — impl integration
// ---------------------------------------------------------------------------

describe("createXyPadImpl — happy path", () => {
  it("returns a non-error result with a summary line", async () => {
    const exec = vi.fn(async () => ({ stdout: happyReport() }));
    const result = await createXyPadImpl(fakeCtx(exec), { ...baseArgs });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("Built XY pad 'xy_pad'");
    expect(text).toContain("(X/Y)");
    expect(text).toContain("/project1/xy_pad/xy_pad_xy");
  });

  it("sends the parent/name/ranges through the payload", async () => {
    const exec = vi.fn(async () => ({ stdout: happyReport() }));
    await createXyPadImpl(fakeCtx(exec), {
      ...baseArgs,
      name: "pad2",
      x_range: [-5, 5],
      y_range: [0, 100],
    });
    const payload = decodePayload(scriptArg(exec));
    expect(payload.name).toBe("pad2");
    expect(payload.x_range).toEqual([-5, 5]);
    expect(payload.y_range).toEqual([0, 100]);
  });

  it("sends axis targets through and reports bound axes in the summary", async () => {
    const exec = vi.fn(async () => ({
      stdout: happyReport({
        z_slider: "/project1/xy_pad/xy_pad_z",
        bound: ["geo1/transform1.tx", "geo1/transform1.ty", "geo1/transform1.tz"],
      }),
    }));
    const result = await createXyPadImpl(fakeCtx(exec), {
      ...baseArgs,
      x_target: "geo1/transform1.tx",
      y_target: "geo1/transform1.ty",
      z_target: "geo1/transform1.tz",
    });
    const payload = decodePayload(scriptArg(exec));
    expect(payload.x_target).toBe("geo1/transform1.tx");
    expect(payload.z_target).toBe("geo1/transform1.tz");
    const text = textOf(result);
    expect(text).toContain("bound 3 axis target(s)");
  });

  it("includes a warning count when the probe reports unexpected channels", async () => {
    const exec = vi.fn(async () => ({
      stdout: happyReport({
        channels: ["chan1", "chan2"],
        warnings: ["Panel CHOP exposed channels ['chan1', 'chan2']; expected u/v drag axes."],
      }),
    }));
    const result = await createXyPadImpl(fakeCtx(exec), { ...baseArgs });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("1 warning(s)");
  });
});

// ---------------------------------------------------------------------------
// Fatal — parent not found
// ---------------------------------------------------------------------------

describe("createXyPadImpl — fatal (parent not found)", () => {
  it("returns isError:true and does not throw", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        container: "",
        xy_chop: "",
        panel_chop: "",
        z_slider: null,
        channels: [],
        bound: [],
        warnings: [],
        fatal: "Parent COMP not found: /nope",
      }),
    }));
    const result = await createXyPadImpl(fakeCtx(exec), { ...baseArgs, parent_path: "/nope" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Parent COMP not found");
  });
});

// ---------------------------------------------------------------------------
// TD offline — guardTd swallows the connection error
// ---------------------------------------------------------------------------

describe("createXyPadImpl — TD offline", () => {
  it("returns isError:true and does not throw when the bridge is unreachable", async () => {
    const exec = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const result = await createXyPadImpl(fakeCtx(exec), { ...baseArgs });
    expect(result.isError).toBe(true);
  });
});
