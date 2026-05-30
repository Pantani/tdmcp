import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import {
  buildCaptureLoopScript,
  createCaptureLoopImpl,
  createCaptureLoopSchema,
} from "../../src/tools/layer2/createCaptureLoop.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Payload {
  parent_path: string;
  name: string;
  protocol: "spout" | "syphon" | "ndi";
  direction: "in" | "out" | "both";
  sender_name: string;
  receiver_name: string;
  source_top: string;
  resolution: number[];
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

/** A representative success report the Python pass would emit. */
function happyReport(
  overrides: Partial<{
    container: string;
    in_top: string;
    out_top: string;
    protocol: string;
    direction: string;
    warnings: string[];
  }> = {},
) {
  return JSON.stringify({
    container: overrides.container ?? "/project1/capture_loop",
    in_top: overrides.in_top ?? "/project1/capture_loop/in_out",
    out_top: overrides.out_top ?? "/project1/capture_loop/send",
    protocol: overrides.protocol ?? "ndi",
    direction: overrides.direction ?? "both",
    warnings: overrides.warnings ?? [],
  });
}

// ---------------------------------------------------------------------------
// buildCaptureLoopScript — pure, no TD needed
// ---------------------------------------------------------------------------

describe("buildCaptureLoopScript (pure payload)", () => {
  it("embeds all schema fields in the base64 payload", () => {
    const script = buildCaptureLoopScript({
      parent_path: "/project1",
      name: "capture_loop",
      protocol: "ndi",
      direction: "both",
      sender_name: "tdmcp_out",
      receiver_name: "Resolume - Composition",
      source_top: "/project1/final",
      resolution: [1280, 720],
    });
    const payload = decodePayload(script);
    expect(payload.parent_path).toBe("/project1");
    expect(payload.name).toBe("capture_loop");
    expect(payload.protocol).toBe("ndi");
    expect(payload.direction).toBe("both");
    expect(payload.sender_name).toBe("tdmcp_out");
    expect(payload.receiver_name).toBe("Resolume - Composition");
    expect(payload.source_top).toBe("/project1/final");
    expect(payload.resolution).toEqual([1280, 720]);
  });

  it("carries spout protocol and out-only direction through the payload", () => {
    const script = buildCaptureLoopScript({
      parent_path: "/project1",
      name: "spout_send",
      protocol: "spout",
      direction: "out",
      sender_name: "TD_Feed",
      receiver_name: "",
      source_top: "/project1/comp/out",
      resolution: [1920, 1080],
    });
    const payload = decodePayload(script);
    expect(payload.protocol).toBe("spout");
    expect(payload.direction).toBe("out");
    expect(payload.sender_name).toBe("TD_Feed");
    expect(payload.source_top).toBe("/project1/comp/out");
    expect(payload.resolution).toEqual([1920, 1080]);
  });

  it("uses only base64 for the payload — no raw source_top literal in the template", () => {
    const tricky = "/project1/UNIQUEMARKER_qux99";
    const script = buildCaptureLoopScript({
      parent_path: "/project1",
      name: "cl",
      protocol: "syphon",
      direction: "in",
      sender_name: "tdmcp_out",
      receiver_name: tricky,
      source_top: "",
      resolution: [1280, 720],
    });
    const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1] ?? "";
    expect(b64.length).toBeGreaterThan(0);
    const decoded = Buffer.from(b64, "base64").toString("utf8");
    expect(decoded).toContain(tricky);
    const templateWithoutBlob = script.replace(b64, "REDACTED");
    expect(templateWithoutBlob).not.toContain("UNIQUEMARKER_qux99");
  });

  it("script imports json/base64, prints json.dumps(report), and uses the KB-confirmed ops", () => {
    const script = buildCaptureLoopScript({
      parent_path: "/project1",
      name: "cl",
      protocol: "ndi",
      direction: "both",
      sender_name: "tdmcp_out",
      receiver_name: "",
      source_top: "/project1/final",
      resolution: [1280, 720],
    });
    expect(script).toContain("import json, base64");
    expect(script).toContain("print(json.dumps(report))");
    // In/out op type maps and helpers present in the template.
    expect(script).toContain("ndiinTOP");
    expect(script).toContain("ndioutTOP");
    expect(script).toContain("syphonspoutinTOP");
    expect(script).toContain("syphonspoutoutTOP");
    expect(script).toContain("selectTOP");
    expect(script).toContain("nullTOP");
    expect(script).toContain("baseCOMP");
  });
});

// ---------------------------------------------------------------------------
// Schema defaults / validation
// ---------------------------------------------------------------------------

describe("createCaptureLoopSchema defaults", () => {
  it("applies all documented defaults from an empty input", () => {
    const parsed = createCaptureLoopSchema.parse({});
    expect(parsed.parent_path).toBe("/project1");
    expect(parsed.name).toBe("capture_loop");
    expect(parsed.protocol).toBe("ndi");
    expect(parsed.direction).toBe("both");
    expect(parsed.sender_name).toBe("tdmcp_out");
    expect(parsed.receiver_name).toBe("");
    expect(parsed.source_top).toBe("");
    expect(parsed.resolution).toEqual([1280, 720]);
  });

  it("rejects an invalid protocol", () => {
    expect(() => createCaptureLoopSchema.parse({ protocol: "rtmp" })).toThrow();
  });

  it("rejects an invalid direction", () => {
    expect(() => createCaptureLoopSchema.parse({ direction: "sideways" })).toThrow();
  });

  it("rejects a resolution that is not length 2", () => {
    expect(() => createCaptureLoopSchema.parse({ resolution: [1280] })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Happy path — impl integration
// ---------------------------------------------------------------------------

describe("createCaptureLoopImpl — happy path", () => {
  it("returns a non-error result with a summary line naming both halves", async () => {
    const exec = vi.fn(async () => ({ stdout: happyReport() }));
    const result = await createCaptureLoopImpl(fakeCtx(exec), {
      parent_path: "/project1",
      name: "capture_loop",
      protocol: "ndi",
      direction: "both",
      sender_name: "tdmcp_out",
      receiver_name: "",
      source_top: "/project1/final",
      resolution: [1280, 720],
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("ndi both capture loop");
    expect(text).toContain("/project1/capture_loop");
    expect(text).toContain("in /project1/capture_loop/in_out");
    expect(text).toContain("out /project1/capture_loop/send");
  });

  it("sends the correct payload (protocol, direction, names, source_top, resolution)", async () => {
    const exec = vi.fn(async () => ({ stdout: happyReport({ protocol: "syphon" }) }));
    await createCaptureLoopImpl(fakeCtx(exec), {
      parent_path: "/project1",
      name: "loop2",
      protocol: "syphon",
      direction: "both",
      sender_name: "TD_Out",
      receiver_name: "MadMapper Main",
      source_top: "/project1/scene/out",
      resolution: [1920, 1080],
    });
    const payload = decodePayload(scriptArg(exec));
    expect(payload.protocol).toBe("syphon");
    expect(payload.direction).toBe("both");
    expect(payload.sender_name).toBe("TD_Out");
    expect(payload.receiver_name).toBe("MadMapper Main");
    expect(payload.source_top).toBe("/project1/scene/out");
    expect(payload.resolution).toEqual([1920, 1080]);
  });

  it("includes a warning count in the summary and omits the in-half when out-only", async () => {
    const exec = vi.fn(async () => ({
      stdout: happyReport({
        direction: "out",
        in_top: "",
        warnings: [
          "direction includes 'out' but source_top is empty - nothing is being published.",
        ],
      }),
    }));
    const result = await createCaptureLoopImpl(fakeCtx(exec), {
      parent_path: "/project1",
      name: "cl",
      protocol: "ndi",
      direction: "out",
      sender_name: "tdmcp_out",
      receiver_name: "",
      source_top: "",
      resolution: [1280, 720],
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("1 warning(s)");
    // out-only: no "in ..." half should appear.
    expect(text).not.toContain("in /project1");
  });
});

// ---------------------------------------------------------------------------
// Fatal — parent COMP not found
// ---------------------------------------------------------------------------

describe("createCaptureLoopImpl — fatal (parent COMP missing)", () => {
  it("returns isError:true and does not throw", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        container: "",
        in_top: "",
        out_top: "",
        protocol: "ndi",
        direction: "both",
        warnings: [],
        fatal: "Parent COMP not found: /nope",
      }),
    }));
    const result = await createCaptureLoopImpl(fakeCtx(exec), {
      parent_path: "/nope",
      name: "cl",
      protocol: "ndi",
      direction: "both",
      sender_name: "tdmcp_out",
      receiver_name: "",
      source_top: "/project1/final",
      resolution: [1280, 720],
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Parent COMP not found");
  });
});

// ---------------------------------------------------------------------------
// TD offline — guardTd swallows the connection error
// ---------------------------------------------------------------------------

describe("createCaptureLoopImpl — TD offline", () => {
  it("returns isError:true and does not throw when the bridge is unreachable", async () => {
    const exec = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const result = await createCaptureLoopImpl(fakeCtx(exec), {
      parent_path: "/project1",
      name: "cl",
      protocol: "ndi",
      direction: "both",
      sender_name: "tdmcp_out",
      receiver_name: "",
      source_top: "/project1/final",
      resolution: [1280, 720],
    });
    expect(result.isError).toBe(true);
  });
});
