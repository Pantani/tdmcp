import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  TOP_WRITE_MAX_BYTES,
  TouchDesignerClient,
  type WriteTopPixelsInput,
} from "../../src/td-client/touchDesignerClient.js";
import { TdApiError, TdConnectionError, TdTimeoutError } from "../../src/td-client/types.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

/** The client's own source, for the source-level injection-safety lock below. */
const CLIENT_SRC = readFileSync(
  fileURLToPath(new URL("../../src/td-client/touchDesignerClient.ts", import.meta.url)),
  "utf8",
);

const server = makeTdServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function makeClient(timeoutMs = 2000): TouchDesignerClient {
  return new TouchDesignerClient({ baseUrl: TD_BASE, timeoutMs });
}

/** Force a timeout via a fetch that never resolves until aborted. */
const hangingFetch: typeof fetch = (_input, init) =>
  new Promise((_resolve, reject) => {
    const signal = init?.signal;
    const abort = () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      reject(err);
    };
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });
  });

/** An older bridge that predates `/api/top/write` answers 404. */
const routeAbsent = () =>
  http.post(`${TD_BASE}/api/top/write`, () =>
    HttpResponse.json(
      { ok: false, error: { message: "endpoint not supported (older bridge)" } },
      { status: 404 },
    ),
  );

/** A tightly packed w×h RGBA uint8 buffer. */
function rgba(width: number, height: number, fill = 7): Uint8Array {
  return new Uint8Array(width * height * 4).fill(fill);
}

/** Push against an older bridge (404) and capture the `/api/exec` script it replays. */
async function captureFallbackScript(
  input: WriteTopPixelsInput,
  report: Record<string, unknown> = REPORT,
): Promise<string> {
  const scripts: string[] = [];
  server.use(
    routeAbsent(),
    http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
      const body = (await request.json()) as { script: string };
      scripts.push(body.script);
      return HttpResponse.json({
        ok: true,
        data: { result: null, stdout: `${JSON.stringify(report)}\n` },
      });
    }),
  );
  await makeClient().writeTopPixels(input);
  return scripts[0] as string;
}

/** Decode the base64 meta the fallback script replays, so we can assert what the
 * script's own runtime lookups will see. */
function metaOf(script: string): Record<string, unknown> {
  const match = script.match(/b64decode\("([A-Za-z0-9+/=]+)"\)\.decode\("utf-8"\)/);
  return JSON.parse(Buffer.from(match?.[1] as string, "base64").toString("utf8"));
}

const INPUT: WriteTopPixelsInput = {
  path: "/project1/ai_tex",
  width: 4,
  height: 2,
  pixels: rgba(4, 2),
};

const REPORT = {
  path: "/project1/ai_tex",
  width: 4,
  height: 2,
  channels: 4,
  format: "uint8",
  bytes: 32,
  origin: "top_left",
  flip: true,
  created: false,
  callbacks_path: "/project1/ai_tex_tdmcp_write",
  storage_key: "tdmcp_pixels",
  cooked: true,
  max_bytes: TOP_WRITE_MAX_BYTES,
  warnings: [],
};

// ---------------------------------------------------------------------------
// Happy path — POST /api/top/write
// ---------------------------------------------------------------------------
describe("TouchDesignerClient.writeTopPixels", () => {
  it("prefers POST /api/top/write and returns the validated shape", async () => {
    let hits = 0;
    let execCalls = 0;
    server.use(
      http.post(`${TD_BASE}/api/top/write`, async ({ request }) => {
        hits += 1;
        const body = (await request.json()) as Record<string, unknown>;
        expect(body.path).toBe("/project1/ai_tex");
        expect(body.width).toBe(4);
        expect(body.height).toBe(2);
        // Defaults: RGBA uint8, top-left origin (a decoded image), create the TOP.
        expect(body.channels).toBe(4);
        expect(body.format).toBe("uint8");
        expect(body.origin).toBe("top_left");
        expect(body.create).toBe(true);
        // The pixels ride as base64 in the JSON body and decode back byte-for-byte.
        const decoded = Buffer.from(body.pixels_b64 as string, "base64");
        expect(decoded.length).toBe(32);
        expect([...decoded]).toEqual([...rgba(4, 2)]);
        return HttpResponse.json({ ok: true, data: REPORT });
      }),
      http.post(`${TD_BASE}/api/exec`, () => {
        execCalls += 1;
        return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
      }),
    );

    const result = await makeClient().writeTopPixels(INPUT);
    expect(hits).toBe(1);
    expect(execCalls).toBe(0);
    expect(result.path).toBe("/project1/ai_tex");
    expect(result.bytes).toBe(32);
    expect(result.flip).toBe(true);
    expect(result.cooked).toBe(true);
    expect(result.callbacks_path).toBe("/project1/ai_tex_tdmcp_write");
  });

  it("passes through channels/format/origin/create and does not flip a bottom-left buffer", async () => {
    server.use(
      http.post(`${TD_BASE}/api/top/write`, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        expect(body.channels).toBe(3);
        expect(body.format).toBe("float32");
        expect(body.origin).toBe("bottom_left");
        expect(body.create).toBe(false);
        return HttpResponse.json({
          ok: true,
          data: { ...REPORT, channels: 3, format: "float32", origin: "bottom_left", flip: false },
        });
      }),
    );

    const result = await makeClient().writeTopPixels({
      path: "/project1/ai_tex",
      width: 2,
      height: 2,
      // 2*2 x 3ch x float32 = 48 bytes
      pixels: new Uint8Array(48),
      channels: 3,
      format: "float32",
      origin: "bottom_left",
      create: false,
    });
    expect(result.flip).toBe(false);
    expect(result.format).toBe("float32");
  });

  it("surfaces the bridge's fail-forward warnings", async () => {
    server.use(
      http.post(`${TD_BASE}/api/top/write`, () =>
        HttpResponse.json({
          ok: true,
          data: {
            ...REPORT,
            callbacks_path: "my_own_callbacks",
            warnings: ["Script TOP /project1/ai_tex already uses callbacks DAT — left untouched."],
          },
        }),
      ),
    );
    const result = await makeClient().writeTopPixels(INPUT);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("left untouched");
  });
});

// ---------------------------------------------------------------------------
// Pre-flight guards — refuse, never pad/truncate/downscale
// ---------------------------------------------------------------------------
describe("TouchDesignerClient.writeTopPixels pre-flight validation", () => {
  it("refuses a buffer whose length disagrees with the geometry (no request sent)", async () => {
    let hits = 0;
    server.use(
      http.post(`${TD_BASE}/api/top/write`, () => {
        hits += 1;
        return HttpResponse.json({ ok: true, data: REPORT });
      }),
    );
    await expect(
      makeClient().writeTopPixels({ ...INPUT, pixels: new Uint8Array(31) }),
    ).rejects.toThrow(/31 bytes but 4x2 x 4 channels x uint8 needs exactly 32/);
    // The bad frame never left the process.
    expect(hits).toBe(0);
  });

  it("never pads or truncates to fit", async () => {
    await expect(
      makeClient().writeTopPixels({ ...INPUT, pixels: new Uint8Array(64) }),
    ).rejects.toThrow(/never padded or truncated/);
  });

  it("refuses a 4K RGBA frame over the cap with an actionable message", async () => {
    let hits = 0;
    server.use(
      http.post(`${TD_BASE}/api/top/write`, () => {
        hits += 1;
        return HttpResponse.json({ ok: true, data: REPORT });
      }),
    );
    const err = await makeClient()
      .writeTopPixels({
        path: "/project1/ai_tex",
        width: 3840,
        height: 2160,
        pixels: new Uint8Array(3840 * 2160 * 4),
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(TdApiError);
    expect(err.message).toContain("33177600 bytes");
    expect(err.message).toContain("refused, not downscaled");
    expect(err.message).toContain("TDMCP_TOP_WRITE_MAX_BYTES");
    expect(err.message).toContain("Movie File In TOP");
    // 33 MB never went over the wire.
    expect(hits).toBe(0);
  });

  it("accepts a 1080p RGBA frame — the reference frame fits under the 8 MiB cap", () => {
    expect(1920 * 1080 * 4).toBeLessThanOrEqual(TOP_WRITE_MAX_BYTES);
  });

  it("honours a raised maxBytes when the bridge's cap was raised too", async () => {
    server.use(
      http.post(`${TD_BASE}/api/top/write`, () =>
        HttpResponse.json({ ok: true, data: { ...REPORT, bytes: 12_000_000 } }),
      ),
    );
    const width = 2000;
    const height = 1500; // 2000*1500*4 = 12,000,000 B > the 8 MiB default
    const result = await makeClient().writeTopPixels({
      path: "/project1/ai_tex",
      width,
      height,
      pixels: new Uint8Array(width * height * 4),
      maxBytes: 16 * 1024 * 1024,
    });
    expect(result.bytes).toBe(12_000_000);
  });

  it("refuses an out-of-range channel count and an unsupported dtype", async () => {
    await expect(
      makeClient().writeTopPixels({ ...INPUT, channels: 5, pixels: new Uint8Array(40) }),
    ).rejects.toThrow(/channels must be 1, 2, 3 or 4/);
    await expect(
      makeClient().writeTopPixels({
        ...INPUT,
        // Only uint8/uint16/float32 are accepted by copyNumpyArray.
        format: "float64" as never,
      }),
    ).rejects.toThrow(/uint8, uint16 or float32/);
  });

  it("refuses non-positive dimensions", async () => {
    await expect(
      makeClient().writeTopPixels({ ...INPUT, width: 0, pixels: new Uint8Array(0) }),
    ).rejects.toThrow(/positive integers/);
  });
});

// ---------------------------------------------------------------------------
// 404 -> exec fallback (older bridge)
// ---------------------------------------------------------------------------
describe("TouchDesignerClient.writeTopPixels exec fallback", () => {
  it("falls back to /api/exec when the endpoint is absent (404), same shape", async () => {
    let execCalls = 0;
    const scripts: string[] = [];
    server.use(
      routeAbsent(),
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        execCalls += 1;
        const body = (await request.json()) as { script: string };
        scripts.push(body.script);
        return HttpResponse.json({
          ok: true,
          data: { result: null, stdout: `${JSON.stringify(REPORT)}\n` },
        });
      }),
    );

    const result = await makeClient().writeTopPixels(INPUT);
    expect(execCalls).toBe(1);

    const script = scripts[0] as string;
    // The fallback replays the same write: copyNumpyArray via a self-contained
    // callbacks DAT (an older bridge has no top_write_service module to import).
    expect(script).toContain("copyNumpyArray");
    expect(script).toContain("scriptTOP");
    expect(script).not.toContain("top_write_service");
    // Both placeholders were substituted — no literal token left behind.
    expect(script).not.toContain("__META_B64__");
    expect(script).not.toContain("__PIXELS_B64__");
    // The pixels ride inside the script body, byte-for-byte.
    expect(script).toContain(Buffer.from(rgba(4, 2)).toString("base64"));

    expect(result.path).toBe("/project1/ai_tex");
    expect(result.bytes).toBe(32);
    expect(result.cooked).toBe(true);
  });

  // Parity with the endpoint's `_apply_pixel_format` (top_write_service.py). Without
  // this, the ONLY path that runs the fallback — an older bridge — would quantize a
  // uint16/float32 push down to the Script TOP's default 8-bit fixed texture, with no
  // warning. A silent fallback is exactly what this project forbids.
  it("carries the pixel-format widening into the fallback — a float32 push is not silently quantized", async () => {
    const script = await captureFallbackScript(
      {
        path: "/project1/ai_tex",
        width: 2,
        height: 2,
        pixels: new Uint8Array(2 * 2 * 4 * 4), // 2x2 x RGBA x float32
        format: "float32",
      },
      { ...REPORT, width: 2, height: 2, format: "float32", bytes: 64 },
    );

    // The same map as top_write_service._PIXEL_FORMATS, mirrored verbatim.
    expect(script).toContain(
      '{"uint16": "rgba16fixed", "float32": "rgba32float"}.get(_m["format"])',
    );
    expect(script).toContain("_node.par.format = _pfmt");
    // The script's runtime lookup will hit: the meta it replays declares float32.
    expect(metaOf(script).format).toBe("float32");
    // Fail-forward like the endpoint: a menu name this TD build rejects becomes a
    // warning (L8 is an UNVERIFIED-live guess), never a throw.
    expect(script).toContain('_warn.append("Could not set %s pixel format to %r for a %s buffer');
    expect(script).toContain("quantized to 8-bit");
    // Applied before the cook, in the endpoint's order (resolution → format → cook).
    expect(script.indexOf("_node.par.resolutionh")).toBeLessThan(
      script.indexOf("_node.par.format"),
    );
    expect(script.indexOf("_node.par.format")).toBeLessThan(
      script.indexOf("_node.cook(force=True)"),
    );
  });

  it("widens a uint16 push to the 16-bit menu value", async () => {
    const script = await captureFallbackScript(
      {
        path: "/project1/ai_tex",
        width: 4,
        height: 2,
        pixels: new Uint8Array(4 * 2 * 4 * 2), // 4x2 x RGBA x uint16
        format: "uint16",
      },
      { ...REPORT, format: "uint16", bytes: 64 },
    );
    expect(metaOf(script).format).toBe("uint16");
    expect(script).toContain("rgba16fixed");
  });

  it("leaves a uint8 push unaffected — no par.format is written for the default dtype", async () => {
    const script = await captureFallbackScript(INPUT);
    expect(metaOf(script).format).toBe("uint8");
    // uint8 is absent from the map, so `.get("uint8")` yields None and the guard skips
    // the assignment — the Script TOP's default 8-bit fixed texture already matches.
    expect(script).not.toContain('"uint8":');
    expect(script).toContain("if _pfmt is not None:");
  });

  // Source-level lock, not a rendered-output check: an added `${x}` would interpolate
  // silently and leave no trace in the rendered script. The exec script's injection
  // safety rests entirely on caller data reaching it ONLY as base64 (which cannot carry
  // a quote, newline, backslash or `$`), so the literal must stay interpolation-free.
  it("keeps TOP_WRITE_EXEC_SCRIPT free of JS template interpolation (source-level lock)", () => {
    const decl = "const TOP_WRITE_EXEC_SCRIPT = `";
    const start = CLIENT_SRC.indexOf(decl);
    expect(start).toBeGreaterThan(-1);
    const bodyStart = start + decl.length;
    const end = CLIENT_SRC.indexOf("`;", bodyStart);
    expect(end).toBeGreaterThan(bodyStart);

    const literal = CLIENT_SRC.slice(bodyStart, end);
    expect(literal).not.toContain("${");
    // The only two channels for caller data.
    expect(literal).toContain("__META_B64__");
    expect(literal).toContain("__PIXELS_B64__");
  });

  it("surfaces a fatal from the exec fallback as TdApiError", async () => {
    server.use(
      routeAbsent(),
      http.post(`${TD_BASE}/api/exec`, () =>
        HttpResponse.json({
          ok: true,
          data: {
            result: null,
            stdout: `${JSON.stringify({
              fatal: "top/write: /project1/noise1 is not a Script TOP (no copyNumpyArray).",
            })}\n`,
          },
        }),
      ),
    );
    await expect(makeClient().writeTopPixels(INPUT)).rejects.toThrow(/not a Script TOP/);
  });

  it("raises TdApiError on a validation 400 from a current bridge (NO exec fallback)", async () => {
    let execCalls = 0;
    server.use(
      http.post(`${TD_BASE}/api/top/write`, () =>
        HttpResponse.json(
          { ok: false, error: { message: "Payload too large: over the 8388608-byte cap." } },
          { status: 400 },
        ),
      ),
      http.post(`${TD_BASE}/api/exec`, () => {
        execCalls += 1;
        return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
      }),
    );
    // A real rejection from a current bridge must surface — not silently re-run
    // the same write through exec (which would bypass the bridge's own cap).
    await expect(makeClient().writeTopPixels(INPUT)).rejects.toThrow(/Payload too large/);
    expect(execCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Typed error mapping
// ---------------------------------------------------------------------------
describe("TouchDesignerClient.writeTopPixels error mapping", () => {
  it("raises TdApiError on a 5xx from the endpoint", async () => {
    server.use(
      http.post(`${TD_BASE}/api/top/write`, () =>
        HttpResponse.json({ ok: false, error: { message: "boom" } }, { status: 500 }),
      ),
    );
    await expect(makeClient().writeTopPixels(INPUT)).rejects.toBeInstanceOf(TdApiError);
  });

  it("raises TdApiError on a malformed report shape", async () => {
    server.use(
      http.post(`${TD_BASE}/api/top/write`, () =>
        HttpResponse.json({ ok: true, data: { path: "/project1/ai_tex" } }),
      ),
    );
    await expect(makeClient().writeTopPixels(INPUT)).rejects.toBeInstanceOf(TdApiError);
  });

  it("raises TdTimeoutError when the endpoint hangs past the deadline", async () => {
    const client = new TouchDesignerClient({
      baseUrl: TD_BASE,
      timeoutMs: 40,
      fetchImpl: hangingFetch,
    });
    await expect(client.writeTopPixels(INPUT)).rejects.toBeInstanceOf(TdTimeoutError);
  });

  it("raises TdConnectionError when the bridge is unreachable", async () => {
    server.use(http.post(`${TD_BASE}/api/top/write`, () => HttpResponse.error()));
    await expect(makeClient().writeTopPixels(INPUT)).rejects.toBeInstanceOf(TdConnectionError);
  });
});
