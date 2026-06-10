import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import {
  connectDaydreamCloudImpl,
  connectDaydreamCloudSchema,
} from "../../src/tools/layer2/connectDaydreamCloud.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface DaydreamPayload {
  parent: string;
  name?: string;
  source_top_path: string;
  server_url: string;
  model_id: string;
  prompt: string;
  strength: number;
  seed: number | null;
  fps: number;
  output_mode: string;
  output_source_name: string;
  active: boolean;
  expose_controls: boolean;
}

function decodePayload(script: string): DaydreamPayload {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (b64 === undefined) throw new Error("no base64 payload found in script");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as DaydreamPayload;
}

function fakeCtx(execResult: object): ToolContext {
  const executePythonScript = vi.fn().mockResolvedValue({
    result: null,
    stdout: JSON.stringify(execResult),
  });
  return {
    client: { executePythonScript },
    logger: silentLogger,
  } as unknown as ToolContext;
}

function fakeErrCtx(err: Error): ToolContext {
  const executePythonScript = vi.fn().mockRejectedValue(err);
  return {
    client: { executePythonScript },
    logger: silentLogger,
  } as unknown as ToolContext;
}

function captureScript(ctx: ToolContext): string {
  const exec = (ctx.client as unknown as Record<string, ReturnType<typeof vi.fn>>)
    .executePythonScript;
  const s = exec?.mock.calls[0]?.[0];
  if (typeof s !== "string") throw new Error("executePythonScript not called with a string");
  return s;
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

function parseJsonFence(result: CallToolResult): Record<string, unknown> {
  const text = textOf(result);
  const match = /```json\n([\s\S]+?)\n```/.exec(text);
  if (!match?.[1]) throw new Error("no JSON fence in result");
  return JSON.parse(match[1]) as Record<string, unknown>;
}

// Cross-cutting check: rendered Python script must NOT contain a hardcoded key literal.
function assertNoHardcodedKey(script: string): void {
  // Should NOT see any plausible API key: long alphanumeric runs that look like tokens.
  // More concretely: "Bearer <something>" should never appear with an actual key value.
  // The script must reference os.environ.get("DAYDREAM_API_KEY") instead.
  expect(script).toContain('os.environ.get("DAYDREAM_API_KEY")');
  // Ensure no inline key assignment like _key = "sk-..." or "Bearer sk-..."
  expect(script).not.toMatch(/["']Bearer\s+[A-Za-z0-9_-]{10,}/);
  expect(script).not.toMatch(/_key\s*=\s*["'][A-Za-z0-9_-]{10,}/);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const BASE_ARGS = {
  source_top_path: "/project1/cam",
} as const;

describe("connectDaydreamCloudSchema", () => {
  it("1. schema validation — accepts minimal input with all defaults", () => {
    const parsed = connectDaydreamCloudSchema.parse(BASE_ARGS);
    expect(parsed.parent_path).toBe("/project1");
    expect(parsed.server_url).toBe("https://api.daydream.live/v1/stream");
    expect(parsed.model_id).toBe("streamdiffusion-v1");
    expect(parsed.fps).toBe(8);
    expect(parsed.output_mode).toBe("syphon");
    expect(parsed.active).toBe(false);
    expect(parsed.expose_controls).toBe(true);
    expect(parsed.strength).toBe(0.7);
  });

  it("1. schema validation — rejects fps > 30", () => {
    expect(() => connectDaydreamCloudSchema.parse({ ...BASE_ARGS, fps: 99 })).toThrow();
  });

  it("1. schema validation — rejects fps < 1", () => {
    expect(() => connectDaydreamCloudSchema.parse({ ...BASE_ARGS, fps: 0 })).toThrow();
  });
});

describe("connectDaydreamCloudImpl", () => {
  it("2. webclientDAT URL — uses default server_url and reflects override", async () => {
    const defaultCtx = fakeCtx({
      container: "/project1/daydream_cloud1",
      output_top: "/project1/daydream_cloud1/out",
      receiver_kind: "syphon",
      server_url: "https://api.daydream.live/v1/stream",
      model_id: "streamdiffusion-v1",
      warnings: [],
    });

    const args = connectDaydreamCloudSchema.parse(BASE_ARGS);
    await connectDaydreamCloudImpl(defaultCtx, args);
    const script = captureScript(defaultCtx);
    const payload = decodePayload(script);

    expect(payload.server_url).toBe("https://api.daydream.live/v1/stream");
    assertNoHardcodedKey(script);

    // override
    const customUrl = "https://staging.daydream.live/v1/stream";
    const overrideCtx = fakeCtx({
      container: "/project1/daydream_cloud1",
      output_top: "/project1/daydream_cloud1/out",
      receiver_kind: "syphon",
      server_url: customUrl,
      model_id: "streamdiffusion-v1",
      warnings: [],
    });
    const argsOverride = connectDaydreamCloudSchema.parse({
      ...BASE_ARGS,
      server_url: customUrl,
    });
    await connectDaydreamCloudImpl(overrideCtx, argsOverride);
    const scriptOverride = captureScript(overrideCtx);
    const payloadOverride = decodePayload(scriptOverride);
    expect(payloadOverride.server_url).toBe(customUrl);
    assertNoHardcodedKey(scriptOverride);
  });

  it("3. output routing — syphon creates syphonspoutinTOP; ndi creates ndiinTOP; output_top returned", async () => {
    const happyReport = (mode: string) => ({
      container: "/project1/daydream_cloud1",
      output_top: "/project1/daydream_cloud1/out",
      receiver_kind: mode,
      server_url: "https://api.daydream.live/v1/stream",
      model_id: "streamdiffusion-v1",
      warnings: [],
    });

    // syphon
    const syphonCtx = fakeCtx(happyReport("syphon"));
    const syphonArgs = connectDaydreamCloudSchema.parse(BASE_ARGS);
    const syphonResult = await connectDaydreamCloudImpl(syphonCtx, syphonArgs);
    const syphonScript = captureScript(syphonCtx);
    const syphonPayload = decodePayload(syphonScript);
    // payload carries the correct output_mode; both receiver types are in the
    // static script template as conditional branches — assert payload, not raw text
    expect(syphonPayload.output_mode).toBe("syphon");
    // script always contains BOTH receiver type names as conditional branches
    expect(syphonScript).toContain("syphonspoutinTOP");
    expect(syphonScript).toContain("ndiinTOP");
    const syphonJson = parseJsonFence(syphonResult);
    expect(syphonJson.output_top).toBe("/project1/daydream_cloud1/out");
    expect(syphonJson.receiver_kind).toBe("syphon");
    assertNoHardcodedKey(syphonScript);

    // ndi — payload carries ndi; same script, different payload value
    const ndiCtx = fakeCtx(happyReport("ndi"));
    const ndiArgs = connectDaydreamCloudSchema.parse({ ...BASE_ARGS, output_mode: "ndi" });
    const ndiResult = await connectDaydreamCloudImpl(ndiCtx, ndiArgs);
    const ndiScript = captureScript(ndiCtx);
    const ndiPayload = decodePayload(ndiScript);
    expect(ndiPayload.output_mode).toBe("ndi");
    const ndiJson = parseJsonFence(ndiResult);
    expect(ndiJson.output_top).toBe("/project1/daydream_cloud1/out");
    expect(ndiJson.receiver_kind).toBe("ndi");
    assertNoHardcodedKey(ndiScript);
  });

  it("4. missing env var — bridge returns fatal; result is errorResult without leaking 'Bearer' or headers", async () => {
    const missingKeyCtx = fakeCtx({
      warnings: [],
      fatal: "DAYDREAM_API_KEY not set in TouchDesigner process environment",
    });
    const args = connectDaydreamCloudSchema.parse(BASE_ARGS);
    const result = await connectDaydreamCloudImpl(missingKeyCtx, args);

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("DAYDREAM_API_KEY");
    // Must not leak auth headers in error message
    expect(text).not.toMatch(/Bearer/);
    expect(text).not.toMatch(/Authorization/);

    const script = captureScript(missingKeyCtx);
    assertNoHardcodedKey(script);
  });

  it("5. timeout — TdTimeoutError produces friendly isError, no crash, no key leaked", async () => {
    const { TdTimeoutError } = await import("../../src/td-client/types.js");
    const timeoutCtx = fakeErrCtx(new TdTimeoutError("bridge timeout after 5000ms"));
    const args = connectDaydreamCloudSchema.parse(BASE_ARGS);
    const result = await connectDaydreamCloudImpl(timeoutCtx, args);

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).not.toMatch(/Bearer/);
    expect(text).not.toMatch(/DAYDREAM_API_KEY\s*=/);
    // Should mention timeout or connection issue
    expect(text.toLowerCase()).toMatch(/timeout|connection|timed/);
  });
});
