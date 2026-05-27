import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import {
  buildOptimizeScript,
  optimizePerformanceImpl,
} from "../../src/tools/layer3/optimizePerformance.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

interface Payload {
  path: string;
  threshold: number;
  apply: boolean;
  scale: number;
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
  if (typeof s !== "string") throw new Error("executePythonScript not called with a script");
  return s;
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

describe("buildOptimizeScript", () => {
  it("embeds path, threshold, apply, and scale in the payload", () => {
    const script = buildOptimizeScript({
      path: "/project1",
      threshold: 2,
      apply: true,
      scale: 0.5,
    });
    const payload = decodePayload(script);
    expect(payload.path).toBe("/project1");
    expect(payload.threshold).toBe(2);
    expect(payload.apply).toBe(true);
    expect(payload.scale).toBe(0.5);
  });
});

describe("optimizePerformanceImpl", () => {
  it("reports the slow nodes and suggests apply:true in scan mode", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        path: "/project1",
        slow: [
          { path: "/project1/blur1", type: "blurTOP", cook_ms: 5.2 },
          { path: "/project1/feedback1", type: "feedbackTOP", cook_ms: 3.1 },
        ],
        optimized: [],
        suggestions: ["/project1/blur1 (blurTOP, 5.2ms): lower its resolution or pre-shrink."],
        warnings: [],
      }),
    }));
    const result = await optimizePerformanceImpl(fakeCtx(exec), {
      path: "/project1",
      threshold_ms: 2,
      apply: false,
      scale: 0.5,
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("Found 2 node(s) over 2ms");
    expect(text).toContain("apply:true");
    // Scan-only: payload carries apply=false.
    expect(decodePayload(scriptArg(exec)).apply).toBe(false);
  });

  it("reports how many TOPs were resized in apply mode", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        path: "/project1",
        slow: [{ path: "/project1/blur1", type: "blurTOP", cook_ms: 5.2 }],
        optimized: [{ path: "/project1/blur1", from: [1920, 1080], to: [960, 540] }],
        suggestions: [],
        warnings: [],
      }),
    }));
    const result = await optimizePerformanceImpl(fakeCtx(exec), {
      path: "/project1",
      threshold_ms: 2,
      apply: true,
      scale: 0.5,
    });
    const text = textOf(result);
    expect(text).toContain("resized 1 TOP(s) to 50%");
  });

  it("returns an error result when the scan reports a fatal", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        path: "/nope",
        slow: [],
        optimized: [],
        suggestions: [],
        warnings: [],
        fatal: "Network not found: /nope",
      }),
    }));
    const result = await optimizePerformanceImpl(fakeCtx(exec), {
      path: "/nope",
      threshold_ms: 2,
      apply: false,
      scale: 0.5,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Network not found");
  });
});
