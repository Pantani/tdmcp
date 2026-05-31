import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { TdConnectionError } from "../../src/td-client/types.js";
import {
  buildInspectGpuScript,
  inspectGpuAndDisplaysImpl,
  inspectGpuAndDisplaysSchema,
} from "../../src/tools/layer3/inspectGpuAndDisplays.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeCtx(exec: ReturnType<typeof vi.fn>): ToolContext {
  return {
    client: {
      endpoint: "http://127.0.0.1:9980",
      executePythonScript: exec,
    },
    logger: silentLogger,
  } as unknown as ToolContext;
}

function resultJson(result: CallToolResult): unknown {
  const text = result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  // jsonResult wraps data in ```json ... ``` — extract the JSON block
  const match = /```json\n([\s\S]+?)\n```/.exec(text);
  if (match?.[1]) return JSON.parse(match[1]);
  return JSON.parse(text);
}

function decodePayload(script: string): { include: string[] | null } {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (b64 === undefined) throw new Error("no base64 payload in script");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as {
    include: string[] | null;
  };
}

// ---------------------------------------------------------------------------
// buildInspectGpuScript
// ---------------------------------------------------------------------------

describe("buildInspectGpuScript", () => {
  it("embeds null include when omitted (all sections)", () => {
    const script = buildInspectGpuScript({});
    const payload = decodePayload(script);
    expect(payload.include).toBeNull();
  });

  it("embeds the include array when provided", () => {
    const script = buildInspectGpuScript({ include: ["gpu"] });
    const payload = decodePayload(script);
    expect(payload.include).toEqual(["gpu"]);
  });
});

// ---------------------------------------------------------------------------
// inspectGpuAndDisplaysImpl
// ---------------------------------------------------------------------------

describe("inspectGpuAndDisplaysImpl", () => {
  it("happy path — no include — returns all three sections", async () => {
    const exec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        gpu: { name: "RTX 4090", driver: "550.00", memory: 24576 },
        monitors: [
          {
            index: 0,
            width: 3840,
            height: 2160,
            refreshRate: 60,
            isPrimary: true,
            left: 0,
            top: 0,
          },
        ],
        performMode: false,
      }),
    });
    const ctx = fakeCtx(exec);
    const result = await inspectGpuAndDisplaysImpl(ctx, {});
    expect(result.isError).not.toBe(true);
    const data = resultJson(result) as Record<string, unknown>;
    expect(data.connected).toBe(true);
    expect((data.gpu as Record<string, unknown>)?.name).toBe("RTX 4090");
    const monitors = data.monitors as Array<Record<string, unknown>>;
    expect(monitors).toHaveLength(1);
    expect(monitors[0]?.isPrimary).toBe(true);
    expect(data.performMode).toBe(false);
  });

  it("subset include:['gpu'] — only gpu in result", async () => {
    const exec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ gpu: { name: "M2 Max", driver: null, memory: null } }),
    });
    const ctx = fakeCtx(exec);
    const result = await inspectGpuAndDisplaysImpl(ctx, { include: ["gpu"] });
    expect(result.isError).not.toBe(true);
    const data = resultJson(result) as Record<string, unknown>;
    expect(data.gpu).toBeDefined();
    expect(data.monitors).toBeUndefined();
    expect(data.performMode).toBeUndefined();
    // Verify the payload only contained "gpu" in include
    const script = exec.mock.calls[0]?.[0] as string;
    const payload = decodePayload(script);
    expect(payload.include).toEqual(["gpu"]);
  });

  it("offline — TdConnectionError — returns connected:false without throwing", async () => {
    const exec = vi.fn().mockRejectedValue(new TdConnectionError("connect ECONNREFUSED"));
    const ctx = fakeCtx(exec);
    const result = await inspectGpuAndDisplaysImpl(ctx, {});
    expect(result.isError).not.toBe(true);
    const data = resultJson(result) as Record<string, unknown>;
    expect(data.connected).toBe(false);
    expect(typeof data.reason).toBe("string");
  });

  it("partial-attribute degrade — nulls preserved, no error", async () => {
    const exec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        gpu: { name: "M2 Max", driver: null, memory: null },
        monitors: [],
        performMode: true,
      }),
    });
    const ctx = fakeCtx(exec);
    const result = await inspectGpuAndDisplaysImpl(ctx, {});
    expect(result.isError).not.toBe(true);
    const data = resultJson(result) as Record<string, unknown>;
    expect(data.connected).toBe(true);
    const gpu = data.gpu as Record<string, unknown>;
    expect(gpu.driver).toBeNull();
    expect(gpu.memory).toBeNull();
    expect(data.monitors).toEqual([]);
    expect(data.performMode).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Zod schema validation
// ---------------------------------------------------------------------------

describe("inspectGpuAndDisplaysSchema", () => {
  it("accepts undefined include (all sections)", () => {
    expect(() => inspectGpuAndDisplaysSchema.parse({})).not.toThrow();
  });

  it("accepts a valid include subset", () => {
    const parsed = inspectGpuAndDisplaysSchema.parse({ include: ["gpu", "monitors"] });
    expect(parsed.include).toEqual(["gpu", "monitors"]);
  });

  it("rejects empty include array (nonempty constraint)", () => {
    expect(() => inspectGpuAndDisplaysSchema.parse({ include: [] })).toThrow();
  });
});
