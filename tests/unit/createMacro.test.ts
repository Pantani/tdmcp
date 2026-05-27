import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { buildMacroScript, createMacroImpl } from "../../src/tools/layer2/createMacro.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

interface Payload {
  comp: string;
  name: string;
  default: number;
  targets: Array<{ param: string; min: number; max: number; curve: number }>;
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
      comp: "/project1",
      macro: "Energy",
      bound: ["/project1/noise1.period"],
      warnings: [],
      ...over,
    }),
  }));

describe("buildMacroScript", () => {
  it("embeds comp, name, default, and targets in the payload", () => {
    const script = buildMacroScript({
      comp: "/project1",
      name: "Energy",
      default: 0.5,
      targets: [{ param: "/project1/noise1.period", min: 1, max: 8, curve: 1 }],
    });
    const payload = decodePayload(script);
    expect(payload.comp).toBe("/project1");
    expect(payload.name).toBe("Energy");
    expect(payload.default).toBe(0.5);
    expect(payload.targets).toHaveLength(1);
    expect(payload.targets[0]).toMatchObject({ param: "/project1/noise1.period", min: 1, max: 8 });
  });

  it("carries the curve exponent for each target", () => {
    const script = buildMacroScript({
      comp: "/project1",
      name: "Depth",
      default: 0,
      targets: [
        { param: "/project1/a.tx", min: 0, max: 10, curve: 2 },
        { param: "/project1/b.ty", min: -5, max: 5, curve: 0.5 },
      ],
    });
    const payload = decodePayload(script);
    expect(payload.targets[0]?.curve).toBe(2);
    expect(payload.targets[1]?.curve).toBe(0.5);
  });
});

describe("createMacroImpl", () => {
  it("returns an error result when report.fatal is set", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        comp: "/project1",
        bound: [],
        warnings: [],
        fatal: "COMP not found: /project1",
      }),
    }));
    const result = await createMacroImpl(fakeCtx(exec), {
      comp_path: "/project1",
      name: "Energy",
      default: 0,
      targets: [{ param: "/project1/noise1.period", min: 0, max: 10, curve: 1 }],
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("COMP not found");
  });

  it("summarises the macro name, comp, and bound count on success", async () => {
    const exec = okReport({
      bound: ["/project1/noise1.period", "/project1/blur1.size"],
    });
    const result = await createMacroImpl(fakeCtx(exec), {
      comp_path: "/project1",
      name: "Energy",
      default: 0.5,
      targets: [
        { param: "/project1/noise1.period", min: 0, max: 8, curve: 1 },
        { param: "/project1/blur1.size", min: 0, max: 20, curve: 1 },
      ],
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    // 'Macro "Energy" on /project1 drives 2 parameter(s).'
    expect(text).toContain("Energy");
    expect(text).toContain("/project1");
    expect(text).toContain("2 parameter(s)");
  });

  it("includes the warning count in the summary when warnings are present", async () => {
    const exec = okReport({
      bound: ["/project1/noise1.period"],
      warnings: ["Target not found: /project1/missing.param"],
    });
    const result = await createMacroImpl(fakeCtx(exec), {
      comp_path: "/project1",
      name: "Energy",
      default: 0,
      targets: [
        { param: "/project1/noise1.period", min: 0, max: 8, curve: 1 },
        { param: "/project1/missing.param", min: 0, max: 1, curve: 1 },
      ],
    });
    expect(result.isError).toBeFalsy();
    // "1 warning(s)" should appear because one target was missing
    expect(textOf(result)).toMatch(/1 warning\(s\)/);
  });

  it("passes the script to executePythonScript with captureStdout=true", async () => {
    const exec = okReport();
    await createMacroImpl(fakeCtx(exec), {
      comp_path: "/project1",
      name: "Energy",
      default: 0,
      targets: [{ param: "/project1/noise1.period", min: 0, max: 10, curve: 1 }],
    });
    const payload = decodePayload(scriptArg(exec));
    expect(payload.comp).toBe("/project1");
    // The second argument to executePythonScript must be true (captureStdout).
    expect(exec.mock.calls[0]?.[1]).toBe(true);
  });
});
