import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import {
  buildKeyframeScript,
  createKeyframeAnimationImpl,
} from "../../src/tools/layer1/createKeyframeAnimation.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

interface Payload {
  parent: string;
  keys: [number, number][];
  targets: string[];
  duration: number;
  loop: boolean;
  easing: string;
  hook: string;
}

function decodePayload(script: string): Payload {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (b64 === undefined) throw new Error("script did not embed a base64 payload");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
}

function fakeCtx(exec: ReturnType<typeof vi.fn>): ToolContext {
  return { client: { executePythonScript: exec }, logger: silentLogger } as unknown as ToolContext;
}

function scriptArg(exec: ReturnType<typeof vi.fn>): string {
  const script = exec.mock.calls[0]?.[0];
  if (typeof script !== "string")
    throw new Error("executePythonScript was not called with a script");
  return script;
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
      container: "/project1/keyframe_anim",
      hook: "/project1/keyframe_anim/anim",
      duration: 4,
      targets: ["/project1/noise1.period"],
      warnings: [],
      ...over,
    }),
  }));

describe("buildKeyframeScript", () => {
  it("base64-embeds the keys/targets/timing and the interpolating Execute DAT hook", () => {
    const script = buildKeyframeScript({
      parent: "/project1",
      keys: [
        [0, 0],
        [2, 1],
      ],
      targets: ["/project1/noise1.period"],
      duration: 2,
      loop: true,
      easing: "smooth",
      hook: "HOOK_TEXT",
    });
    const payload = decodePayload(script);
    expect(payload.keys).toEqual([
      [0, 0],
      [2, 1],
    ]);
    expect(payload.targets).toEqual(["/project1/noise1.period"]);
    expect(payload.loop).toBe(true);
    // The script stores config on the container and installs an Execute DAT on frame start.
    expect(script).toContain('store("tdmcp_keyframes"');
    expect(script).toContain("framestart");
  });
});

describe("createKeyframeAnimationImpl", () => {
  it("sorts keyframes by time and derives the loop duration from the last key", async () => {
    const exec = okReport();
    await createKeyframeAnimationImpl(fakeCtx(exec), {
      targets: ["/project1/noise1.period"],
      keyframes: [
        { time: 2, value: 10 },
        { time: 0, value: 0 },
        { time: 1, value: 5 },
      ],
      loop: true,
      easing: "smooth",
      parent_path: "/project1",
    });
    const payload = decodePayload(scriptArg(exec));
    expect(payload.keys).toEqual([
      [0, 0],
      [1, 5],
      [2, 10],
    ]);
    expect(payload.duration).toBe(2);
  });

  it("carries loop=false and the easing mode into the payload", async () => {
    const exec = okReport({ duration: 3 });
    await createKeyframeAnimationImpl(fakeCtx(exec), {
      targets: ["/project1/a.tx", "/project1/b.ty"],
      keyframes: [
        { time: 0, value: 0 },
        { time: 3, value: 1 },
      ],
      loop: false,
      easing: "linear",
      parent_path: "/project1",
    });
    const payload = decodePayload(scriptArg(exec));
    expect(payload.loop).toBe(false);
    expect(payload.easing).toBe("linear");
    expect(payload.targets).toEqual(["/project1/a.tx", "/project1/b.ty"]);
  });

  it("rejects a zero-duration span without ever touching TD", async () => {
    const exec = vi.fn();
    const result = await createKeyframeAnimationImpl(fakeCtx(exec), {
      targets: ["/project1/noise1.period"],
      keyframes: [
        { time: 0, value: 0 },
        { time: 0, value: 1 },
      ],
      loop: true,
      easing: "smooth",
      parent_path: "/project1",
    });
    expect(result.isError).toBe(true);
    expect(exec).not.toHaveBeenCalled();
  });

  it("summarizes the created animation from the TD report", async () => {
    const exec = okReport({ duration: 4, targets: ["/project1/noise1.period"] });
    const result = await createKeyframeAnimationImpl(fakeCtx(exec), {
      targets: ["/project1/noise1.period"],
      keyframes: [
        { time: 0, value: 0 },
        { time: 4, value: 1 },
      ],
      loop: true,
      easing: "smooth",
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("/project1/keyframe_anim");
    expect(text).toContain("4s");
    expect(text).toContain("loop");
  });
});
