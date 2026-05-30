import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import {
  buildTimeEchoScript,
  createTimeEchoImpl,
  createTimeEchoSchema,
} from "../../src/tools/layer2/createTimeEcho.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Payload {
  parent_path: string;
  name: string;
  source_top: string;
  mode: "echo" | "slit_scan" | "time_displace";
  frames: number;
  feedback: number;
  displace_top: string;
  resolution: [number, number];
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
    mode: string;
    frames: number;
    feedback: number;
    output_top: string;
    cache_optype: string;
    timemachine_optype: string;
    warnings: string[];
  }> = {},
) {
  return JSON.stringify({
    container: "/project1/time_echo",
    output_top: overrides.output_top ?? "/project1/time_echo/out",
    source_select: "/project1/time_echo/sel",
    mode: overrides.mode ?? "echo",
    frames: overrides.frames ?? 60,
    feedback: overrides.feedback ?? 0.5,
    cache_optype: overrides.cache_optype ?? "",
    timemachine_optype: overrides.timemachine_optype ?? "",
    warnings: overrides.warnings ?? [],
  });
}

// ---------------------------------------------------------------------------
// buildTimeEchoScript — pure, no TD needed
// ---------------------------------------------------------------------------

describe("buildTimeEchoScript (pure payload)", () => {
  it("embeds all schema fields in the base64 payload", () => {
    const script = buildTimeEchoScript({
      parent_path: "/project1",
      name: "time_echo",
      source_top: "/project1/moviefilein1",
      mode: "echo",
      frames: 60,
      feedback: 0.5,
      displace_top: "",
      resolution: [1280, 720],
    });
    const payload = decodePayload(script);
    expect(payload.parent_path).toBe("/project1");
    expect(payload.name).toBe("time_echo");
    expect(payload.source_top).toBe("/project1/moviefilein1");
    expect(payload.mode).toBe("echo");
    expect(payload.frames).toBe(60);
    expect(payload.feedback).toBe(0.5);
    expect(payload.displace_top).toBe("");
    expect(payload.resolution).toEqual([1280, 720]);
  });

  it("embeds slit_scan / time_displace settings when provided", () => {
    const script = buildTimeEchoScript({
      parent_path: "/project1",
      name: "tm",
      source_top: "/project1/in1",
      mode: "time_displace",
      frames: 120,
      feedback: 0.5,
      displace_top: "/project1/grad",
      resolution: [1920, 1080],
    });
    const payload = decodePayload(script);
    expect(payload.mode).toBe("time_displace");
    expect(payload.frames).toBe(120);
    expect(payload.displace_top).toBe("/project1/grad");
    expect(payload.resolution).toEqual([1920, 1080]);
  });

  it("uses only base64 for the payload — no raw source_top literal in the script outside the blob", () => {
    const tricky = "/project1/UNIQUEMARKER_xyzzy";
    const script = buildTimeEchoScript({
      parent_path: "/project1",
      name: "tm",
      source_top: tricky,
      mode: "echo",
      frames: 60,
      feedback: 0.5,
      displace_top: "",
      resolution: [1280, 720],
    });
    const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1] ?? "";
    expect(b64.length).toBeGreaterThan(0);
    const decoded = Buffer.from(b64, "base64").toString("utf8");
    expect(decoded).toContain(tricky);
    const templateWithoutBlob = script.replace(b64, "REDACTED");
    expect(templateWithoutBlob).not.toContain("UNIQUEMARKER_xyzzy");
  });

  it("script imports json and base64 and prints json.dumps(report)", () => {
    const script = buildTimeEchoScript({
      parent_path: "/project1",
      name: "tm",
      source_top: "/project1/in1",
      mode: "echo",
      frames: 60,
      feedback: 0.5,
      displace_top: "",
      resolution: [1280, 720],
    });
    expect(script).toContain("import json, base64");
    expect(script).toContain("print(json.dumps(report))");
    // All three mode paths + the live-probe loop are present in the template.
    expect(script).toContain("selectTOP");
    expect(script).toContain("feedbackTOP");
    expect(script).toContain("overTOP");
    expect(script).toContain("cacheTOP");
    expect(script).toContain("timeMachineTOP");
    expect(script).toContain("cacheSelectTOP");
    expect(script).toContain("nullTOP");
  });

  it("forces resolution on the feedback path (echo never stays black)", () => {
    const script = buildTimeEchoScript({
      parent_path: "/project1",
      name: "tm",
      source_top: "/project1/in1",
      mode: "echo",
      frames: 60,
      feedback: 0.7,
      displace_top: "",
      resolution: [1280, 720],
    });
    expect(script).toContain("resolutionw");
    expect(script).toContain("resolutionh");
    // The feedback loop is closed via par.top (mirrors create_feedback_tunnel).
    expect(script).toContain("feedback loop");
  });
});

// ---------------------------------------------------------------------------
// Schema defaults
// ---------------------------------------------------------------------------

describe("createTimeEchoSchema defaults", () => {
  it("applies all documented defaults", () => {
    const parsed = createTimeEchoSchema.parse({ source_top: "/project1/in1" });
    expect(parsed.parent_path).toBe("/project1");
    expect(parsed.name).toBe("time_echo");
    expect(parsed.mode).toBe("echo");
    expect(parsed.frames).toBe(60);
    expect(parsed.feedback).toBe(0.5);
    expect(parsed.displace_top).toBe("");
    expect(parsed.resolution).toEqual([1280, 720]);
  });

  it("coerces numeric strings for frames and feedback", () => {
    const parsed = createTimeEchoSchema.parse({
      source_top: "/s",
      frames: "90",
      feedback: "0.8",
    });
    expect(parsed.frames).toBe(90);
    expect(parsed.feedback).toBe(0.8);
  });

  it("rejects feedback > 1", () => {
    expect(() => createTimeEchoSchema.parse({ source_top: "/s", feedback: 1.5 })).toThrow();
  });

  it("rejects frames < 2", () => {
    expect(() => createTimeEchoSchema.parse({ source_top: "/s", frames: 1 })).toThrow();
  });

  it("rejects a non-integer frames value", () => {
    expect(() => createTimeEchoSchema.parse({ source_top: "/s", frames: 60.5 })).toThrow();
  });

  it("rejects an invalid mode", () => {
    expect(() => createTimeEchoSchema.parse({ source_top: "/s", mode: "warp" })).toThrow();
  });

  it("rejects a resolution that is not length 2", () => {
    expect(() => createTimeEchoSchema.parse({ source_top: "/s", resolution: [1280] })).toThrow();
  });

  it("requires source_top", () => {
    expect(() => createTimeEchoSchema.parse({})).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Happy path — impl integration
// ---------------------------------------------------------------------------

describe("createTimeEchoImpl — happy path", () => {
  it("returns a non-error result with a summary line (echo)", async () => {
    const exec = vi.fn(async () => ({ stdout: happyReport() }));
    const result = await createTimeEchoImpl(fakeCtx(exec), {
      parent_path: "/project1",
      name: "time_echo",
      source_top: "/project1/moviefilein1",
      mode: "echo",
      frames: 60,
      feedback: 0.5,
      displace_top: "",
      resolution: [1280, 720],
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("echo time effect");
    expect(text).toContain("/project1/moviefilein1");
    expect(text).toContain("feedback 0.5");
    expect(text).toContain("/project1/time_echo/out");
  });

  it("sends the correct payload (source_top, mode, frames, feedback, displace_top)", async () => {
    const exec = vi.fn(async () => ({ stdout: happyReport({ mode: "time_displace" }) }));
    await createTimeEchoImpl(fakeCtx(exec), {
      parent_path: "/project1",
      name: "tm",
      source_top: "/project1/in1",
      mode: "time_displace",
      frames: 120,
      feedback: 0.5,
      displace_top: "/project1/grad",
      resolution: [1920, 1080],
    });
    const payload = decodePayload(scriptArg(exec));
    expect(payload.source_top).toBe("/project1/in1");
    expect(payload.mode).toBe("time_displace");
    expect(payload.frames).toBe(120);
    expect(payload.displace_top).toBe("/project1/grad");
    expect(payload.resolution).toEqual([1920, 1080]);
  });

  it("summarizes slit_scan with the frame count and probed time-machine optype", async () => {
    const exec = vi.fn(async () => ({
      stdout: happyReport({
        mode: "slit_scan",
        frames: 90,
        cache_optype: "cacheTOP",
        timemachine_optype: "timeMachineTOP",
      }),
    }));
    const result = await createTimeEchoImpl(fakeCtx(exec), {
      parent_path: "/project1",
      name: "tm",
      source_top: "/project1/in1",
      mode: "slit_scan",
      frames: 90,
      feedback: 0.5,
      displace_top: "",
      resolution: [1280, 720],
    });
    const text = textOf(result);
    expect(text).toContain("slit_scan time effect");
    expect(text).toContain("90 frames");
    expect(text).toContain("via timeMachineTOP");
  });

  it("includes a warning count in the summary when warnings are present", async () => {
    const exec = vi.fn(async () => ({
      stdout: happyReport({
        warnings: [
          "No time-machine / cacheSelect TOP optype found on this TD build (tried timeMachineTOP, cacheSelectTOP); reading the cache directly.",
        ],
      }),
    }));
    const result = await createTimeEchoImpl(fakeCtx(exec), {
      parent_path: "/project1",
      name: "tm",
      source_top: "/project1/in1",
      mode: "slit_scan",
      frames: 60,
      feedback: 0.5,
      displace_top: "",
      resolution: [1280, 720],
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("1 warning(s)");
  });
});

// ---------------------------------------------------------------------------
// Fatal — source not found
// ---------------------------------------------------------------------------

describe("createTimeEchoImpl — fatal (source not found)", () => {
  it("returns isError:true and does not throw", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        container: "",
        output_top: "",
        source_select: "",
        mode: "echo",
        frames: 60,
        feedback: 0.5,
        cache_optype: "",
        timemachine_optype: "",
        warnings: [],
        fatal: "Source TOP not found: /project1/missing",
      }),
    }));
    const result = await createTimeEchoImpl(fakeCtx(exec), {
      parent_path: "/project1",
      name: "tm",
      source_top: "/project1/missing",
      mode: "echo",
      frames: 60,
      feedback: 0.5,
      displace_top: "",
      resolution: [1280, 720],
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Source TOP not found");
  });
});

// ---------------------------------------------------------------------------
// TD offline — guardTd swallows the connection error
// ---------------------------------------------------------------------------

describe("createTimeEchoImpl — TD offline", () => {
  it("returns isError:true and does not throw when the bridge is unreachable", async () => {
    const exec = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const result = await createTimeEchoImpl(fakeCtx(exec), {
      parent_path: "/project1",
      name: "tm",
      source_top: "/project1/in1",
      mode: "echo",
      frames: 60,
      feedback: 0.5,
      displace_top: "",
      resolution: [1280, 720],
    });
    expect(result.isError).toBe(true);
  });
});
