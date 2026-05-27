import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import {
  buildRandomizeScript,
  randomizeControlsImpl,
} from "../../src/tools/layer2/randomizeControls.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

interface Payload {
  comp: string;
  params: string[] | null;
  amount: number;
  seed: number | null;
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
  vi.fn(async () => ({
    stdout: JSON.stringify({
      comp: "/project1",
      randomized: [{ name: "period", value: 3.14 }],
      skipped: [],
      warnings: [],
      ...over,
    }),
  }));

describe("buildRandomizeScript", () => {
  it("embeds comp, params, amount, and seed in the payload", () => {
    const script = buildRandomizeScript({
      comp: "/project1",
      params: ["period", "gain"],
      amount: 0.4,
      seed: 42,
    });
    const payload = decodePayload(script);
    expect(payload.comp).toBe("/project1");
    expect(payload.params).toEqual(["period", "gain"]);
    expect(payload.amount).toBe(0.4);
    expect(payload.seed).toBe(42);
  });

  it("passes params: null through so Python randomizes all numeric parameters", () => {
    const script = buildRandomizeScript({ comp: "/project1", params: null, amount: 1, seed: null });
    const payload = decodePayload(script);
    expect(payload.params).toBeNull();
    expect(payload.seed).toBeNull();
  });
});

describe("randomizeControlsImpl", () => {
  it("passes the correct payload fields to the script", async () => {
    const exec = okReport();
    await randomizeControlsImpl(fakeCtx(exec), {
      comp_path: "/project1",
      params: ["period", "gain"],
      amount: 0.5,
      seed: 7,
    });
    const payload = decodePayload(scriptArg(exec));
    expect(payload.comp).toBe("/project1");
    expect(payload.params).toEqual(["period", "gain"]);
    expect(payload.amount).toBe(0.5);
    expect(payload.seed).toBe(7);
  });

  it("returns an error result when report.fatal is set", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        comp: "/project1",
        randomized: [],
        skipped: [],
        warnings: [],
        fatal: "COMP not found",
      }),
    }));
    const result = await randomizeControlsImpl(fakeCtx(exec), {
      comp_path: "/project1",
      params: undefined,
      amount: 0.5,
      seed: undefined,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("COMP not found");
  });

  it("summarises randomised count, comp, and amount in the happy-path result", async () => {
    const exec = okReport({
      randomized: [
        { name: "period", value: 2.5 },
        { name: "gain", value: 0.7 },
      ],
      skipped: ["tx"],
    });
    const result = await randomizeControlsImpl(fakeCtx(exec), {
      comp_path: "/project1",
      params: undefined,
      amount: 0.8,
      seed: undefined,
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    // "Randomized 2 control(s) on /project1 (amount 0.8), skipped 1 non-numeric."
    expect(text).toContain("2");
    expect(text).toContain("/project1");
    expect(text).toContain("0.8");
    expect(text).toContain("skipped 1 non-numeric");
  });
});
