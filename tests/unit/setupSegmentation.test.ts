import { describe, expect, it, vi } from "vitest";
import {
  buildSegmentationScript,
  setupSegmentationImpl,
  setupSegmentationSchema,
} from "../../src/tools/layer2/setupSegmentation.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

interface Payload {
  tox_path: string;
  parent: string;
  adapter_name: string;
  model: string;
  smooth: boolean;
  publish_prekeyed: boolean;
  invert_mask: boolean;
  feather_px: number;
}

function decodePayload(script: string): Payload {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (b64 === undefined) throw new Error("script did not embed a base64 payload");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as Payload;
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

function okExec(report: Record<string, unknown>) {
  return vi.fn(async () => ({ stdout: JSON.stringify(report) }));
}

function resultText(result: Awaited<ReturnType<typeof setupSegmentationImpl>>): string {
  return (result.content?.[0] as { text?: string } | undefined)?.text ?? "";
}

describe("buildSegmentationScript", () => {
  it("round-trips the payload", () => {
    const payload = {
      tox_path: "/some/MediaPipe.tox",
      parent: "/project1",
      adapter_name: "mp_segmentation",
      model: "general",
      smooth: true,
      publish_prekeyed: true,
      invert_mask: false,
      feather_px: 2,
    };
    const script = buildSegmentationScript(payload);
    expect(decodePayload(script)).toEqual(payload);
  });
});

describe("setupSegmentationImpl", () => {
  it("happy path with pre-keyed branch surfaces mask and person_rgba paths", async () => {
    const exec = okExec({
      engine: "/project1/MediaPipe",
      mask_top: "/project1/mp_segmentation/mask",
      person_rgba_top: "/project1/mp_segmentation/person_rgba",
      model: "general",
      warnings: [],
      errors: [],
    });
    const result = await setupSegmentationImpl(fakeCtx(exec), {
      tox_path: "/tox/MediaPipe.tox",
      parent_path: "/project1",
      model: "general",
      smooth: true,
      publish_prekeyed: true,
      invert_mask: false,
      feather_px: 2,
      name: "mp_segmentation",
    });
    expect(result.isError).not.toBe(true);
    const p = decodePayload(scriptArg(exec));
    expect(p.tox_path).toBe("/tox/MediaPipe.tox");
    expect(p.parent).toBe("/project1");
    expect(p.adapter_name).toBe("mp_segmentation");
    expect(p.model).toBe("general");
    expect(p.feather_px).toBe(2);
    const text = resultText(result);
    expect(text).toContain("/project1/mp_segmentation/mask");
    expect(text).toContain("/project1/mp_segmentation/person_rgba");
  });

  it("publish_prekeyed=false produces null person_rgba_top and omits from summary", async () => {
    const exec = okExec({
      engine: "/project1/MediaPipe",
      mask_top: "/project1/mp_segmentation/mask",
      person_rgba_top: null,
      model: "general",
      warnings: [],
      errors: [],
    });
    const result = await setupSegmentationImpl(fakeCtx(exec), {
      tox_path: "/tox/MediaPipe.tox",
      parent_path: "/project1",
      model: "general",
      smooth: true,
      publish_prekeyed: false,
      invert_mask: false,
      feather_px: 2,
      name: "mp_segmentation",
    });
    expect(result.isError).not.toBe(true);
    const p = decodePayload(scriptArg(exec));
    expect(p.publish_prekeyed).toBe(false);
    const text = resultText(result);
    // The summary line should not mention the person_rgba path (only the JSON fence has null)
    const summaryLine = text.split("\n")[0] ?? "";
    expect(summaryLine).not.toContain("person_rgba");
  });

  it("mask_not_found error returns isError with hint", async () => {
    const exec = okExec({ warnings: [], error: "mask_not_found" });
    const result = await setupSegmentationImpl(fakeCtx(exec), {
      tox_path: "/tox/MediaPipe.tox",
      parent_path: "/project1",
      model: "general",
      smooth: true,
      publish_prekeyed: true,
      invert_mask: false,
      feather_px: 2,
      name: "mp_segmentation",
    });
    expect(result.isError).toBe(true);
    const text = resultText(result);
    expect(text).toContain("enable Selfie Segmentation");
  });

  it("tox_missing error returns isError with install hint", async () => {
    const exec = okExec({ warnings: [], error: "tox_missing" });
    const result = await setupSegmentationImpl(fakeCtx(exec), {
      tox_path: "/tox/MediaPipe.tox",
      parent_path: "/project1",
      model: "general",
      smooth: true,
      publish_prekeyed: true,
      invert_mask: false,
      feather_px: 2,
      name: "mp_segmentation",
    });
    expect(result.isError).toBe(true);
    const text = resultText(result);
    expect(text).toContain("tdmcp install mediapipe-touchdesigner");
  });

  it("invert_mask and zero feather are forwarded in the payload", async () => {
    const exec = okExec({
      engine: "/project1/MediaPipe",
      mask_top: "/project1/mp_segmentation/mask",
      person_rgba_top: null,
      model: "general",
      warnings: [],
      errors: [],
    });
    await setupSegmentationImpl(fakeCtx(exec), {
      tox_path: "/tox/MediaPipe.tox",
      parent_path: "/project1",
      model: "general",
      smooth: false,
      publish_prekeyed: false,
      invert_mask: true,
      feather_px: 0,
      name: "mp_segmentation",
    });
    const p = decodePayload(scriptArg(exec));
    expect(p.invert_mask).toBe(true);
    expect(p.feather_px).toBe(0);
    expect(p.smooth).toBe(false);
  });

  it("bridge offline (throws TdConnectionError) produces errorResult without throwing", async () => {
    const exec = vi.fn(async () => {
      throw Object.assign(new Error("Connection refused"), { code: "TdConnectionError" });
    });
    const result = await setupSegmentationImpl(fakeCtx(exec), {
      tox_path: "/tox/MediaPipe.tox",
      parent_path: "/project1",
      model: "general",
      smooth: true,
      publish_prekeyed: true,
      invert_mask: false,
      feather_px: 2,
      name: "mp_segmentation",
    });
    expect(result.isError).toBe(true);
    const text = resultText(result);
    expect(text.length).toBeGreaterThan(0);
  });

  it("schema rejects feather_px out of range", () => {
    expect(() =>
      setupSegmentationSchema.parse({
        feather_px: 33,
      }),
    ).toThrow();
  });

  it("schema provides defaults for all optional fields", () => {
    const parsed = setupSegmentationSchema.parse({});
    expect(parsed.parent_path).toBe("/project1");
    expect(parsed.model).toBe("general");
    expect(parsed.smooth).toBe(true);
    expect(parsed.publish_prekeyed).toBe(true);
    expect(parsed.invert_mask).toBe(false);
    expect(parsed.feather_px).toBe(2);
  });
});
