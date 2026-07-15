import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { buildRecordScript, recordMovieImpl } from "../../src/tools/layer3/recordMovie.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

interface Payload {
  action: string;
  node: string;
  file: string | null;
  fps: number;
  seconds: number | null;
  video_codec?: string | null;
  video_codec_type?: string | null;
  movie_pixel_format?: string | null;
  hook: string;
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

describe("buildRecordScript", () => {
  it("embeds the action, node, file, fps, and seconds in the payload", () => {
    const script = buildRecordScript({
      action: "start",
      node: "/project1/render1",
      file: "/tmp/out.mov",
      fps: 30,
      seconds: 10,
      hook: "HOOK_TEXT",
    });
    const payload = decodePayload(script);
    expect(payload.action).toBe("start");
    expect(payload.node).toBe("/project1/render1");
    expect(payload.file).toBe("/tmp/out.mov");
    expect(payload.fps).toBe(30);
    expect(payload.seconds).toBe(10);
  });
});

describe("recordMovieImpl", () => {
  it("reports an open-ended recording when no auto-stop is set", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        action: "start",
        recording: "/tmp/out.mov",
        warnings: [],
      }),
    }));
    const result = await recordMovieImpl(fakeCtx(exec), {
      action: "start",
      node_path: "/project1/render1",
      file: "/tmp/out.mov",
      fps: 30,
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("/tmp/out.mov");
    expect(text).toContain("call stop to finish");
    // file/seconds forwarded; seconds null when omitted.
    const payload = decodePayload(scriptArg(exec));
    expect(payload.file).toBe("/tmp/out.mov");
    expect(payload.seconds).toBeNull();
  });

  it("forwards optional codec settings and surfaces recorder warnings", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        action: "start",
        recording: "/tmp/out.mov",
        warnings: ["Could not apply video codec=hap on /project1/tdmcp_record."],
      }),
    }));
    const result = await recordMovieImpl(fakeCtx(exec), {
      action: "start",
      node_path: "/project1/render1",
      file: "/tmp/out.mov",
      fps: 60,
      video_codec: "hap",
      video_codec_type: "hap",
      movie_pixel_format: "rgba",
    });
    expect(textOf(result)).toContain("Could not apply video codec=hap");
    const payload = decodePayload(scriptArg(exec));
    expect(payload.video_codec).toBe("hap");
    expect(payload.video_codec_type).toBe("hap");
    expect(payload.movie_pixel_format).toBe("rgba");
  });

  it("notes the auto-stop duration when seconds is provided", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        action: "start",
        recording: "/tmp/loop.mov",
        auto_stop_seconds: 8,
        warnings: [],
      }),
    }));
    const result = await recordMovieImpl(fakeCtx(exec), {
      action: "start",
      node_path: "/project1/render1",
      file: "/tmp/loop.mov",
      fps: 30,
      seconds: 8,
    });
    expect(textOf(result)).toContain("auto-stops after 8s");
  });

  it("reports the stopped file path for the stop action", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        action: "stop",
        stopped: "/tmp/out.mov",
        warnings: [],
      }),
    }));
    const result = await recordMovieImpl(fakeCtx(exec), {
      action: "stop",
      node_path: "/project1/render1",
      fps: 30,
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("Stopped recording");
    expect(textOf(result)).toContain("/tmp/out.mov");
  });

  it("returns an error result when the report carries a fatal", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        action: "start",
        warnings: [],
        fatal: "A file path is required to start recording.",
      }),
    }));
    const result = await recordMovieImpl(fakeCtx(exec), {
      action: "start",
      node_path: "/project1/render1",
      fps: 30,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("file path is required");
  });
});
