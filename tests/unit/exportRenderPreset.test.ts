import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import {
  exportRenderPresetImpl,
  resolveRenderPreset,
} from "../../src/tools/layer3/exportRenderPreset.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

function fakeCtx(exec: ReturnType<typeof vi.fn>): ToolContext {
  return { client: { executePythonScript: exec }, logger: silentLogger } as unknown as ToolContext;
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

function decodePayload(exec: ReturnType<typeof vi.fn>) {
  const script = exec.mock.calls[0]?.[0];
  if (typeof script !== "string") throw new Error("executePythonScript not called");
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (!b64) throw new Error("no embedded payload");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as {
    action: string;
    node: string;
    file: string | null;
    fps: number;
    seconds: number | null;
    video_codec: string | null;
    video_codec_type: string | null;
    movie_pixel_format: string | null;
  };
}

describe("resolveRenderPreset", () => {
  it("uses preset defaults and warns on mismatched extension", () => {
    const preset = resolveRenderPreset({
      action: "start",
      preset: "hap",
      node_path: "/project1/out1",
      file: "/tmp/review.mp4",
    });
    expect(preset.fps).toBe(60);
    expect(preset.recommended_extension).toBe(".mov");
    expect(preset.warnings.join(" ")).toContain(".mov");
  });
});

describe("exportRenderPresetImpl", () => {
  it("delegates recording to record_movie with the preset fps", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        action: "start",
        recording: "/tmp/out.mov",
        auto_stop_seconds: 4,
        warnings: [],
      }),
    }));
    const result = await exportRenderPresetImpl(fakeCtx(exec), {
      action: "start",
      preset: "hap_alpha",
      node_path: "/project1/out1",
      file: "/tmp/out.mov",
      seconds: 4,
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("HAP Alpha");
    expect(textOf(result)).toContain("auto-stops after 4s");
    const payload = decodePayload(exec);
    expect(payload.fps).toBe(60);
    expect(payload.seconds).toBe(4);
    expect(payload.video_codec).toBe("hap");
    expect(payload.video_codec_type).toBe("hap");
    expect(payload.movie_pixel_format).toBe("rgba");
  });

  it("surfaces record_movie fatal errors while preserving preset context", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        action: "start",
        warnings: [],
        fatal: "A file path is required to start recording.",
      }),
    }));
    const result = await exportRenderPresetImpl(fakeCtx(exec), {
      action: "start",
      preset: "prores_422",
      node_path: "/project1/out1",
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("ProRes 422");
    expect(textOf(result)).toContain("file path is required");
  });
});
