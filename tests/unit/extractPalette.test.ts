import zlib from "node:zlib";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { extractPaletteImpl } from "../../src/tools/layer3/extractPalette.js";
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

function reportOf(result: { content: unknown[] }) {
  const text = (result.content[0] as { text: string }).text;
  const m = text.match(/```json\n([\s\S]*?)\n```/);
  if (!m?.[1]) throw new Error(`no json: ${text}`);
  return JSON.parse(m[1]);
}

// Tiny deterministic two-color PNG (one half red, one half blue).
function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i] ?? 0;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
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
function twoColorPng(): string {
  const sig = Buffer.from("89504e470d0a1a0a", "hex");
  const w = 4;
  const h = 2;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const stride = w * 3;
  const raw = Buffer.alloc(h * (stride + 1));
  // Row 0: red filter=0
  raw[0] = 0;
  for (let x = 0; x < w; x++) {
    raw[1 + x * 3] = 255;
    raw[1 + x * 3 + 1] = 0;
    raw[1 + x * 3 + 2] = 0;
  }
  // Row 1: blue
  raw[stride + 1] = 0;
  for (let x = 0; x < w; x++) {
    raw[stride + 2 + x * 3] = 0;
    raw[stride + 2 + x * 3 + 1] = 0;
    raw[stride + 2 + x * 3 + 2] = 255;
  }
  const idat = chunk("IDAT", zlib.deflateSync(raw));
  return Buffer.concat([sig, chunk("IHDR", ihdr), idat, chunk("IEND", Buffer.alloc(0))]).toString(
    "base64",
  );
}

describe("extractPaletteImpl", () => {
  it("returns a 2-color palette containing red and blue", async () => {
    server.use(
      http.get(`${TD_BASE}/api/preview/:seg`, () =>
        ok({
          path: "/project1/out1",
          width: 4,
          height: 2,
          base64: twoColorPng(),
          mime_type: "image/png",
        }),
      ),
    );
    const result = await extractPaletteImpl(makeCtx(), {
      source_top: "/project1/out1",
      k: 2,
      width: 4,
      height: 2,
    });
    expect(result.isError).toBeFalsy();
    const r = reportOf(result);
    expect(r.hex_colors.length).toBe(2);
    const hexes = r.hex_colors.join(",");
    expect(hexes).toMatch(/#ff0000|#0000ff/);
    expect(r.swatches[0].weight).toBeGreaterThan(0);
  });

  it("returns a friendly error when TD is unreachable", async () => {
    const badCtx: ToolContext = {
      client: new TouchDesignerClient({ baseUrl: "http://127.0.0.1:1", timeoutMs: 50 }),
      knowledge: new KnowledgeBase(),
      recipes: new RecipeLibrary(),
      logger: silentLogger,
    };
    const result = await extractPaletteImpl(badCtx, {
      source_top: "/project1/out1",
      k: 3,
      width: 32,
      height: 32,
    });
    expect(result.isError).toBe(true);
  });

  it("falls back to byte-histogram when the preview is not a real PNG", async () => {
    server.use(
      http.get(`${TD_BASE}/api/preview/:seg`, () =>
        ok({
          path: "/project1/out1",
          width: 4,
          height: 2,
          base64: Buffer.from("not a png at all").toString("base64"),
          mime_type: "image/png",
        }),
      ),
    );
    const result = await extractPaletteImpl(makeCtx(), {
      source_top: "/project1/out1",
      k: 2,
      width: 4,
      height: 2,
    });
    expect(result.isError).toBeFalsy();
    const r = reportOf(result);
    expect(r.warnings.some((w: string) => w.includes("byte-histogram"))).toBe(true);
  });
});
