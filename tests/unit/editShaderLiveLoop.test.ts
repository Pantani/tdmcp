import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { TdApiError } from "../../src/td-client/types.js";
import {
  editShaderLiveLoopImpl,
  editShaderLiveLoopSchema,
} from "../../src/tools/layer3/editShaderLiveLoop.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

interface FakeClientOptions {
  datText?: string;
  putReport?: { old_length: number; new_length: number };
  errors?: Array<{ path: string; type?: string; message: string }>;
  previewFatal?: string;
}

function stdout(report: Record<string, unknown>): { stdout: string } {
  return { stdout: JSON.stringify(report) };
}

function decodePayload(script: string): Record<string, unknown> {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (b64 === undefined) throw new Error("script did not embed a base64 payload");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as Record<string, unknown>;
}

function fakeCtx(options: FakeClientOptions = {}) {
  const calls: Array<{ kind: string; value?: unknown }> = [];
  const client = {
    putDatText: vi.fn(async (path: string, text: string) => {
      calls.push({ kind: "putDatText", value: { path, text } });
      return {
        old_length: options.putReport?.old_length ?? 4,
        new_length: options.putReport?.new_length ?? text.length,
      };
    }),
    getDatText: vi.fn(async (path: string) => {
      calls.push({ kind: "getDatText", value: { path } });
      return { text: options.datText ?? "void main() { gl_FragColor = vec4(0.0); }" };
    }),
    getNodeErrors: vi.fn(async (path: string) => {
      calls.push({ kind: "getNodeErrors", value: { path } });
      return { errors: options.errors ?? [] };
    }),
    getNetworkErrors: vi.fn(async (path: string) => {
      calls.push({ kind: "getNetworkErrors", value: { path } });
      return { errors: options.errors ?? [] };
    }),
    getPreview: vi.fn(async (path: string, width: number, height: number) => {
      calls.push({ kind: "getPreview", value: { path, width, height } });
      return {
        path,
        width,
        height,
        format: "png",
        base64:
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      };
    }),
    executePythonScript: vi.fn(async (script: string) => {
      const payload = decodePayload(script);
      calls.push({ kind: "executePythonScript", value: payload });
      if (options.previewFatal) {
        return stdout({
          cook: {},
          errors: [],
          inspected_paths: [],
          changed_params: [],
          parameters: null,
          warnings: [],
          fatal: options.previewFatal,
        });
      }
      return stdout({
        type: "glslTOP",
        family: "TOP",
        cook: {
          cook_time_ms: 0.5,
          cook_count: 5,
          width: 640,
          height: 360,
          pixel_format: "RGBA8",
        },
        errors: [],
        inspected_paths: [payload.path],
        changed_params: [{ name: "resolution", value: 1 }],
        parameters: null,
        thumbnail: { base64: "AAAA", format: payload.target_format, bytes: 256 },
        warnings: [],
      });
    }),
  };
  return {
    ctx: { client, logger: silentLogger } as unknown as ToolContext,
    client,
    calls,
  };
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

function jsonOf(result: CallToolResult): Record<string, unknown> {
  const match = /```json\n([\s\S]*?)\n```/.exec(textOf(result));
  if (!match?.[1]) throw new Error("result did not contain a JSON fence");
  return JSON.parse(match[1]) as Record<string, unknown>;
}

describe("editShaderLiveLoopSchema", () => {
  it("defaults to set mode with preview enabled", () => {
    const parsed = editShaderLiveLoopSchema.parse({
      dat_path: "/project1/glsl1_pixel",
      shader_code: "void main(){}",
    });
    expect(parsed.mode).toBe("set");
    expect(parsed.include_preview).toBe(true);
    expect(parsed.preview_width).toBe(256);
  });
});

describe("editShaderLiveLoopImpl", () => {
  it("set mode writes the full shader, checks errors, and compacts preview base64", async () => {
    const { ctx, client } = fakeCtx();
    const result = await editShaderLiveLoopImpl(
      ctx,
      editShaderLiveLoopSchema.parse({
        dat_path: "/project1/glsl1_pixel",
        shader_code: "void main() { gl_FragColor = vec4(1.0); }",
        preview_path: "/project1/glsl1",
      }),
    );

    expect(result.isError).toBeFalsy();
    expect(client.putDatText).toHaveBeenCalledWith(
      "/project1/glsl1_pixel",
      "void main() { gl_FragColor = vec4(1.0); }",
    );
    expect(client.getNodeErrors).toHaveBeenCalledWith("/project1/glsl1");
    const data = jsonOf(result);
    expect(data.mode).toBe("set");
    expect(data.error_path).toBe("/project1/glsl1");
    const preview = data.preview as { thumbnail: Record<string, unknown> };
    expect(preview.thumbnail.base64_omitted).toBe(true);
    expect(preview.thumbnail).not.toHaveProperty("base64");
    expect(textOf(result)).toContain("post-edit check found 0 error(s)");
  });

  it("replace mode reuses DAT read/replace/write and supports recursive error checks", async () => {
    const { ctx, client } = fakeCtx({
      datText: "uniform float gain;\nvoid main() { gl_FragColor = vec4(gain); }",
    });
    const result = await editShaderLiveLoopImpl(
      ctx,
      editShaderLiveLoopSchema.parse({
        dat_path: "/project1/glsl1_pixel",
        mode: "replace",
        old_string: "vec4(gain)",
        new_string: "vec4(gain, 0.0, 1.0, 1.0)",
        error_path: "/project1",
        recursive_errors: true,
        include_preview: false,
      }),
    );

    expect(result.isError).toBeFalsy();
    expect(client.getDatText).toHaveBeenCalledWith("/project1/glsl1_pixel");
    expect(client.putDatText).toHaveBeenCalledWith(
      "/project1/glsl1_pixel",
      "uniform float gain;\nvoid main() { gl_FragColor = vec4(gain, 0.0, 1.0, 1.0); }",
    );
    expect(client.getNetworkErrors).toHaveBeenCalledWith("/project1");
    expect(jsonOf(result).mode).toBe("replace");
  });

  it("returns isError when required mode fields are missing", async () => {
    const { ctx, client } = fakeCtx();
    const result = await editShaderLiveLoopImpl(
      ctx,
      editShaderLiveLoopSchema.parse({ dat_path: "/project1/glsl1_pixel" }),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("requires shader_code");
    expect(client.putDatText).not.toHaveBeenCalled();
  });

  it("stops when the DAT edit fails", async () => {
    const { ctx, client } = fakeCtx();
    client.putDatText.mockRejectedValueOnce(new TdApiError("DAT not found", { status: 400 }));

    const result = await editShaderLiveLoopImpl(
      ctx,
      editShaderLiveLoopSchema.parse({
        dat_path: "/project1/missing_pixel",
        shader_code: "void main(){}",
        preview_path: "/project1/glsl1",
      }),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Could not edit shader DAT");
    expect(client.getPreview).not.toHaveBeenCalled();
  });

  it("keeps the edit successful when preview capture fails and records a warning", async () => {
    const { ctx } = fakeCtx({ previewFatal: "compile failed" });
    const result = await editShaderLiveLoopImpl(
      ctx,
      editShaderLiveLoopSchema.parse({
        dat_path: "/project1/glsl1_pixel",
        shader_code: "void main(){}",
        preview_path: "/project1/glsl1",
      }),
    );

    expect(result.isError).toBeFalsy();
    const data = jsonOf(result);
    expect(data.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("Could not capture preview")]),
    );
    expect(textOf(result)).toContain("warning(s)");
  });
});
