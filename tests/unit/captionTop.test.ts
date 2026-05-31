import zlib from "node:zlib";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { captionTopImpl, captionTopSchema } from "../../src/tools/layer3/captionTop.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

const server = makeTdServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function makeCtx(): ToolContext {
  return {
    client: new TouchDesignerClient({ baseUrl: TD_BASE, timeoutMs: 2000 }),
    knowledge: new KnowledgeBase(),
    recipes: new RecipeLibrary(),
    logger: silentLogger,
  };
}

const ok = (data: unknown) => HttpResponse.json({ ok: true, data });

function reportOf(result: { content: unknown[] }): {
  source: string;
  caption: string;
  stats: { mean_luma: number; mean_r: number; classification: string; decoded: boolean };
  warnings: string[];
} {
  // jsonResult wraps the report in a ```json … ``` fence; pull the JSON back out.
  const text = (result.content[0] as { text: string }).text;
  const match = text.match(/```json\n([\s\S]*?)\n```/);
  if (!match || match[1] === undefined) {
    throw new Error(`no JSON fence in result text:\n${text}`);
  }
  return JSON.parse(match[1]);
}

// --- Tiny deterministic PNG encoder (single colour, filter type 0) ------------
// Builds a valid 8-bit truecolor PNG so the tool decodes REAL pixels in tests,
// rather than relying on the shared mock's 1x1 placeholder (which is colour-type
// 4 and intentionally exercises the byte-histogram fallback elsewhere).

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i] ?? 0;
    for (let k = 0; k < 8; k++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** Encode a width×height solid-colour RGB PNG and return its base64. */
function solidPng(width: number, height: number, r: number, g: number, b: number): string {
  const sig = Buffer.from("89504e470d0a1a0a", "hex");
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type 2 = truecolor RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter type 0 (None)
    for (let x = 0; x < width; x++) {
      const px = rowStart + 1 + x * 3;
      raw[px] = r;
      raw[px + 1] = g;
      raw[px + 2] = b;
    }
  }
  const idat = zlib.deflateSync(raw);
  const png = Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return png.toString("base64");
}

function previewHandler(base64: string) {
  return http.get(`${TD_BASE}/api/preview/:seg`, ({ params, request }) => {
    const url = new URL(request.url);
    const raw = params.seg;
    const path = decodeURIComponent(Array.isArray(raw) ? (raw[0] ?? "") : String(raw));
    return ok({
      path,
      width: Number(url.searchParams.get("width") ?? 320),
      height: Number(url.searchParams.get("height") ?? 180),
      format: "png",
      base64,
    });
  });
}

// capturePreview probes perform-mode via /api/exec first; the default mock returns
// {result:null, stdout:""} → JSON.parse fails → treated as NOT in perform mode, so
// the preview proceeds. Each test overrides the preview handler with a known PNG.

describe("caption_top", () => {
  it("schema defaults: width 320, height 180, use_vision true", () => {
    const parsed = captionTopSchema.parse({ node_path: "/project1/out1" });
    expect(parsed.width).toBe(320);
    expect(parsed.height).toBe(180);
    expect(parsed.use_vision).toBe(true);
  });

  it("describes a black image as black with ~0 mean luma (histogram path)", async () => {
    server.use(previewHandler(solidPng(4, 4, 0, 0, 0)));
    const result = await captionTopImpl(makeCtx(), {
      node_path: "/project1/out1",
      width: 4,
      height: 4,
      use_vision: true,
    });

    expect(result.isError).toBeFalsy();
    const report = reportOf(result);
    expect(report.source).toBe("histogram");
    expect(report.stats.decoded).toBe(true);
    expect(report.stats.mean_luma).toBeLessThan(0.01);
    expect(report.stats.classification).toBe("black");
    expect(report.caption.toLowerCase()).toContain("black");
  });

  it("does NOT call a non-black image black, and reports colour (histogram path)", async () => {
    server.use(previewHandler(solidPng(4, 4, 220, 10, 10))); // strong red
    const result = await captionTopImpl(makeCtx(), {
      node_path: "/project1/out1",
      width: 4,
      height: 4,
      use_vision: true,
    });

    expect(result.isError).toBeFalsy();
    const report = reportOf(result);
    expect(report.caption.toLowerCase()).not.toContain("black");
    expect(report.stats.decoded).toBe(true);
    expect(report.stats.mean_luma).toBeGreaterThan(0.05);
    expect(report.stats.mean_r).toBeGreaterThan(report.stats.mean_luma);
    expect(report.stats.classification).toBe("colorful");
    expect(report.caption.toLowerCase()).toContain("red");
  });

  it("use_vision with no endpoint falls back to histogram and warns", async () => {
    server.use(previewHandler(solidPng(2, 2, 128, 128, 128)));
    const result = await captionTopImpl(makeCtx(), {
      node_path: "/project1/out1",
      width: 2,
      height: 2,
      use_vision: true,
    });

    const report = reportOf(result);
    expect(report.source).toBe("histogram");
    expect(report.warnings.some((w) => w.toLowerCase().includes("no vision endpoint"))).toBe(true);
  });

  it("uses a configured vision endpoint when present (probed via ctx)", async () => {
    server.use(previewHandler(solidPng(2, 2, 0, 0, 0)));
    const ctx = makeCtx() as ToolContext & {
      vision: { describeImage: (i: { base64: string }) => Promise<string> };
    };
    let received = "";
    ctx.vision = {
      describeImage: async ({ base64 }) => {
        received = base64;
        return "A swirling blue nebula.";
      },
    };

    const result = await captionTopImpl(ctx, {
      node_path: "/project1/out1",
      width: 2,
      height: 2,
      use_vision: true,
    });

    const report = reportOf(result);
    expect(report.source).toBe("vision");
    expect(report.caption).toBe("A swirling blue nebula.");
    expect(received.length).toBeGreaterThan(0);
  });

  it("vision endpoint failure falls back to histogram without throwing", async () => {
    server.use(previewHandler(solidPng(2, 2, 0, 0, 0)));
    const ctx = makeCtx() as ToolContext & {
      vision: { describeImage: () => Promise<string> };
    };
    ctx.vision = {
      describeImage: async () => {
        throw new Error("model offline");
      },
    };

    const result = await captionTopImpl(ctx, {
      node_path: "/project1/out1",
      width: 2,
      height: 2,
      use_vision: true,
    });

    expect(result.isError).toBeFalsy();
    const report = reportOf(result);
    expect(report.source).toBe("histogram");
    expect(report.warnings.some((w) => w.toLowerCase().includes("vision endpoint failed"))).toBe(
      true,
    );
  });

  it("non-PNG preview falls back to an approximate byte-histogram (decoded:false)", async () => {
    server.use(previewHandler(Buffer.from("not a png at all").toString("base64")));
    const result = await captionTopImpl(makeCtx(), {
      node_path: "/project1/out1",
      width: 8,
      height: 8,
      use_vision: false,
    });

    expect(result.isError).toBeFalsy();
    const report = reportOf(result);
    expect(report.stats.decoded).toBe(false);
    expect(report.warnings.some((w) => w.toLowerCase().includes("byte-histogram"))).toBe(true);
  });

  it("rejects a non-positive width via the schema", () => {
    expect(() => captionTopSchema.parse({ node_path: "/x", width: 0 })).toThrow();
  });

  it("TD offline (bridge error) returns isError and does not throw", async () => {
    server.use(
      http.get(`${TD_BASE}/api/preview/:seg`, () => HttpResponse.error()),
      // perform-mode probe also fails offline; both should be handled gracefully.
      http.post(`${TD_BASE}/api/exec`, () => HttpResponse.error()),
    );

    const result = await captionTopImpl(makeCtx(), {
      node_path: "/project1/out1",
      width: 4,
      height: 4,
      use_vision: false,
    });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text.length).toBeGreaterThan(0);
  });
});
