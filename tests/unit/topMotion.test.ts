import zlib from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";

const capturePreviewMock = vi.fn();
vi.mock("../../src/feedback/previewCapture.js", () => ({
  capturePreview: (...args: unknown[]) => capturePreviewMock(...args),
}));

import { topMotion } from "../../src/feedback/topMotion.js";

/** Minimal 8-bit grayscale PNG of a solid value. CRC bytes are dummy (the
 *  decoder skips them), so this is enough to exercise the decoded path. */
function grayPng(width: number, height: number, value: number): Buffer {
  const sig = Buffer.from("89504e470d0a1a0a", "hex");
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // colour type: grayscale
  const stride = width + 1;
  const raw = Buffer.alloc(stride * height, value);
  for (let y = 0; y < height; y++) raw[y * stride] = 0; // filter byte 0 per row
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    return Buffer.concat([len, Buffer.from(type, "ascii"), data, Buffer.alloc(4)]);
  };
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngPreview(value: number) {
  return {
    path: "/p/out",
    width: 4,
    height: 4,
    base64: grayPng(4, 4, value).toString("base64"),
    mimeType: "image/png",
  };
}

function fakeClient(): TouchDesignerClient {
  const exec = vi.fn().mockResolvedValue({ stdout: "" });
  return { executePythonScript: exec } as unknown as TouchDesignerClient;
}

beforeEach(() => capturePreviewMock.mockReset());

describe("topMotion", () => {
  it("returns delta ≈ 0 for two identical frames", async () => {
    capturePreviewMock
      .mockResolvedValueOnce(pngPreview(120))
      .mockResolvedValueOnce(pngPreview(120));
    const result = await topMotion(fakeClient(), "/p/out", 6);
    expect(result.delta).toBeCloseTo(0, 5);
    expect(result.warnings).toHaveLength(0);
  });

  it("returns delta > 0 when the second frame is brighter", async () => {
    capturePreviewMock.mockResolvedValueOnce(pngPreview(40)).mockResolvedValueOnce(pngPreview(200));
    const result = await topMotion(fakeClient(), "/p/out", 6);
    expect(result.delta).toBeGreaterThan(0.4);
  });

  it("advances the timeline between the two captures", async () => {
    capturePreviewMock.mockResolvedValueOnce(pngPreview(50)).mockResolvedValueOnce(pngPreview(50));
    const client = fakeClient();
    await topMotion(client, "/p/out", 12);
    const exec = client.executePythonScript as unknown as ReturnType<typeof vi.fn>;
    expect(exec).toHaveBeenCalledTimes(1);
    expect(String(exec.mock.calls[0]?.[0])).toContain("_t.frame + 12");
  });

  it("folds an undecodable frame into a warning, not a throw", async () => {
    // Non-PNG buffers decode via the byte-histogram fallback (decoded: false).
    const junk = (mean: number) => ({
      path: "/p/out",
      width: 1,
      height: 1,
      base64: Buffer.alloc(64, mean).toString("base64"),
      mimeType: "image/png",
    });
    capturePreviewMock.mockResolvedValueOnce(junk(10)).mockResolvedValueOnce(junk(200));
    const result = await topMotion(fakeClient(), "/p/out", 6);
    expect(result.delta).toBeGreaterThan(0);
    expect(result.warnings.some((w) => w.includes("could not decode"))).toBe(true);
  });
});
