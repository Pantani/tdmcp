import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { detectPitchImpl } from "../../src/tools/layer1/detectPitch.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

interface CreatedNodeBody {
  parent_path: string;
  type: string;
  name?: string;
  parameters?: Record<string, unknown>;
}

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

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

// Records every POST /api/nodes body so a test can assert what parameters a builder asked
// the bridge to set on a node (and echoes back a deterministic created path).
function captureCreateBodies(): CreatedNodeBody[] {
  const bodies: CreatedNodeBody[] = [];
  server.use(
    http.post(`${TD_BASE}/api/nodes`, async ({ request }) => {
      const body = (await request.json()) as CreatedNodeBody;
      bodies.push(body);
      const name = body.name ?? `${body.type.replace(/[^a-zA-Z0-9]/g, "").toLowerCase()}1`;
      return HttpResponse.json({
        ok: true,
        data: { path: `${body.parent_path}/${name}`, type: body.type, name },
      });
    }),
  );
  return bodies;
}

describe("detect_pitch", () => {
  it("builds a pitch tracker that outputs a Null with pitch_hz / note / confidence", async () => {
    const result = await detectPitchImpl(makeCtx(), {
      source: "oscillator",
      min_hz: 80,
      max_hz: 2000,
      expose_controls: false,
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("/project1/pitch");
    expect(text).toContain("/project1/pitch/pitch");
    expect(text).toContain("pitch_hz");
    // The argmax method + experimental flag must be reported.
    expect(text).toContain("highestpeakindex");
    expect(text).toContain('"experimental": true');
  });

  it("runs the FFT in 1-sample-per-Hz mode (visual + frequencylog 0) so a bin index IS Hz", async () => {
    const bodies = captureCreateBodies();
    await detectPitchImpl(makeCtx(), {
      source: "oscillator",
      min_hz: 80,
      max_hz: 2000,
      expose_controls: false,
      parent_path: "/project1",
    });
    const fft = bodies.find((b) => b.name === "spectrum_fft");
    expect(fft?.type).toBe("audiospectrumCHOP");
    // visual + frequencylog=0 is the documented config that yields exactly 1 sample per Hz.
    expect(fft?.parameters).toMatchObject({
      mode: "visual",
      frequencylog: 0,
      outputmenu: "setmanually",
    });
    // outlength tracks max_hz (so the channel spans 0..max_hz Hz), clamped into TD's range.
    expect(fft?.parameters?.outlength).toBe(2000);
  });

  it("clamps the FFT outlength into TD's 128..16384 sample range", async () => {
    const tiny = captureCreateBodies();
    await detectPitchImpl(makeCtx(), {
      source: "oscillator",
      min_hz: 50,
      max_hz: 100, // below 128 → clamped up
      expose_controls: false,
      parent_path: "/project1",
    });
    expect(tiny.find((b) => b.name === "spectrum_fft")?.parameters?.outlength).toBe(128);

    server.resetHandlers();
    const huge = captureCreateBodies();
    const res = await detectPitchImpl(makeCtx(), {
      source: "oscillator",
      min_hz: 80,
      max_hz: 50000, // above 16384 → clamped down + flagged
      expose_controls: false,
      parent_path: "/project1",
    });
    expect(huge.find((b) => b.name === "spectrum_fft")?.parameters?.outlength).toBe(16384);
    expect(textOf(res)).toContain('"search_ceiling_clamped": true');
  });

  it("trims the spectrum to the search band, then argmaxes within it", async () => {
    const bodies = captureCreateBodies();
    await detectPitchImpl(makeCtx(), {
      source: "oscillator",
      min_hz: 100,
      max_hz: 800,
      expose_controls: false,
      parent_path: "/project1",
    });
    // The Audio Spectrum spans [0, rate/2] across `outlength` bins, so a Hz maps to sample
    // index ≈ hz * outlength / (44100/2) — NOT index==Hz. With min_hz=100, max_hz=800 and
    // outlength=800: start = round(100*800/22050) = 4, end = round(800*800/22050) = 29.
    const band = bodies.find((b) => b.name === "search_band");
    expect(band?.type).toBe("trimCHOP");
    expect(band?.parameters).toMatchObject({
      relative: "abs",
      start: 4,
      end: 29,
      startunit: "samples",
      endunit: "samples",
      discard: "exterior",
    });
    // The dominant-bin search is highestpeakindex (the index of the highest spectral peak).
    const idx = bodies.find((b) => b.name === "peak_index");
    expect(idx?.type).toBe("analyzeCHOP");
    expect(idx?.parameters).toMatchObject({ function: "highestpeakindex" });
  });

  it("converts the peak bin to Hz via Hz-per-bin = (rate/2)/outlength (index × gain + offset)", async () => {
    const bodies = captureCreateBodies();
    await detectPitchImpl(makeCtx(), {
      source: "oscillator",
      min_hz: 120,
      max_hz: 900,
      expose_controls: false,
      parent_path: "/project1",
    });
    // The Audio Spectrum spans [0, rate/2] across `outlength` bins, so Hz = bin × (rate/2)/outlength
    // (live-verified: a 440 Hz tone → bin 40 → 441 Hz). A Math CHOP applies it as bin×gain + postoff:
    // gain = Hz-per-bin, postoff = bandStart × Hz-per-bin. With max_hz=900 → outlength=900 →
    // Hz-per-bin = 22050/900 = 24.5. (An Expression CHOP reading the live rate was tried but TD set
    // its value rather than its expression, passing the input through unchanged — Math CHOP is used.)
    const toHz = bodies.find((b) => b.name === "to_hz");
    expect(toHz?.type).toBe("mathCHOP");
    const pars = toHz?.parameters as { gain?: number; integer?: string };
    expect(pars?.gain).toBeCloseTo(24.5, 1);
    expect(pars?.integer).toBe("round");
  });

  it("gates the reported pitch to 0 below a magnitude Threshold", async () => {
    const bodies = captureCreateBodies();
    await detectPitchImpl(makeCtx(), {
      source: "oscillator",
      min_hz: 80,
      max_hz: 2000,
      expose_controls: false,
      parent_path: "/project1",
    });
    // A Logic CHOP in "bound" mode emits 1 only while magnitude >= boundmin (Threshold).
    const gate = bodies.find((b) => b.name === "gate");
    expect(gate?.type).toBe("logicCHOP");
    expect(gate?.parameters).toMatchObject({ convert: "bound" });
    // pitch_hz is multiplied by that gate, so silence collapses the frequency to 0.
    const gated = bodies.find((b) => b.name === "gated_hz");
    expect(gated?.type).toBe("mathCHOP");
    expect(gated?.parameters).toMatchObject({ chopop: "mul" });
  });

  it("uses a clean sine (not white noise) for the device-free oscillator test", async () => {
    const bodies = captureCreateBodies();
    await detectPitchImpl(makeCtx(), {
      source: "oscillator",
      min_hz: 80,
      max_hz: 2000,
      expose_controls: false,
      parent_path: "/project1",
    });
    // White noise has no single dominant bin; a sine gives one clean peak ~440 Hz, in range.
    const osc = bodies.find((b) => b.name === "audioin");
    expect(osc?.type).toBe("audiooscillatorCHOP");
    expect(osc?.parameters).toMatchObject({ wavetype: "sine", frequency: 440 });
  });

  it("uses the existing CHOP path as the source without creating an input node", async () => {
    const bodies = captureCreateBodies();
    await detectPitchImpl(makeCtx(), {
      source: "existing_chop",
      existing_chop_path: "/project1/myaudio",
      min_hz: 80,
      max_hz: 2000,
      expose_controls: false,
      parent_path: "/project1",
    });
    // No audio input node is created; the FFT reads from the supplied CHOP.
    expect(bodies.some((b) => b.name === "audioin")).toBe(false);
    expect(bodies.some((b) => b.name === "spectrum_fft")).toBe(true);
  });

  it("exposes Sensitivity + Threshold knobs bound to the right node parameters", async () => {
    const scripts: string[] = [];
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        scripts.push(((await request.json()) as { script: string }).script);
        return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
      }),
    );
    await detectPitchImpl(makeCtx(), {
      source: "oscillator",
      min_hz: 80,
      max_hz: 2000,
      expose_controls: true,
      parent_path: "/project1",
    });
    const panel = scripts.find((s) => s.includes("appendCustomPage"));
    expect(panel).toBeDefined();
    const b64 = /b64decode\("([^"]+)"\)/.exec(panel ?? "")?.[1];
    if (b64 === undefined) throw new Error("panel script did not embed a base64 payload");
    const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as {
      controls: Array<{ name: string; bind_to?: string[] }>;
    };
    const sens = payload.controls.find((c) => c.name === "Sensitivity");
    const thresh = payload.controls.find((c) => c.name === "Threshold");
    expect(sens?.bind_to?.[0]).toMatch(/sensitivity\.gain$/);
    expect(thresh?.bind_to?.[0]).toMatch(/gate\.boundmin$/);
  });

  it("uses the same default Threshold magnitude for the gate boundmin and the exposed Threshold knob default", async () => {
    // Regression: the ROADMAP flagged "near-zero default threshold" on detect_pitch. The
    // contract this test pins is intra-build consistency — whatever the chosen default
    // magnitude is, the Logic CHOP gate.boundmin and the Threshold control default MUST
    // match (otherwise the live knob "snaps" the gate the instant the artist touches it,
    // and the magnitude that ships in the build silently disagrees with what the UI shows).
    const bodies = captureCreateBodies();
    const scripts: string[] = [];
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        scripts.push(((await request.json()) as { script: string }).script);
        return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
      }),
    );
    await detectPitchImpl(makeCtx(), {
      source: "oscillator",
      min_hz: 80,
      max_hz: 2000,
      expose_controls: true,
      parent_path: "/project1",
    });
    const gate = bodies.find((b) => b.name === "gate");
    const gateBoundMin = gate?.parameters?.boundmin as number | undefined;
    expect(typeof gateBoundMin).toBe("number");

    const panel = scripts.find((s) => s.includes("appendCustomPage"));
    expect(panel).toBeDefined();
    const b64 = /b64decode\("([^"]+)"\)/.exec(panel ?? "")?.[1];
    if (b64 === undefined) throw new Error("panel script did not embed a base64 payload");
    const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as {
      controls: Array<{ name: string; default?: number }>;
    };
    const thresh = payload.controls.find((c) => c.name === "Threshold");
    expect(thresh?.default).toBe(gateBoundMin);
  });

  it("matches its own documented Threshold default (notes string vs hard-coded DEFAULT_THRESHOLD)", async () => {
    // Pins notes string to the hard-coded DEFAULT_THRESHOLD.
    const result = await detectPitchImpl(makeCtx(), {
      source: "oscillator",
      min_hz: 80,
      max_hz: 2000,
      expose_controls: false,
      parent_path: "/project1",
    });
    const text = textOf(result);
    // The notes string now advertises 0.0005 to match the hard-coded gate. They MUST agree.
    const match = /Threshold default \(([0-9.]+)\)/.exec(text);
    expect(match).not.toBeNull();
    const documented = Number(match?.[1]);
    // hard-coded DEFAULT_THRESHOLD in src/tools/layer1/detectPitch.ts
    const HARDCODED = 0.0005;
    expect(documented).toBe(HARDCODED);
  });

  it("orders the search range when min_hz >= max_hz instead of erroring", async () => {
    const bodies = captureCreateBodies();
    const res = await detectPitchImpl(makeCtx(), {
      source: "oscillator",
      min_hz: 1500,
      max_hz: 200, // inverted on purpose
      expose_controls: false,
      parent_path: "/project1",
    });
    expect(res.isError).toBeFalsy();
    // The build still produces a valid trim with start < end (re-ordered).
    const band = bodies.find((b) => b.name === "search_band");
    const start = band?.parameters?.start as number;
    const end = band?.parameters?.end as number;
    expect(start).toBeLessThan(end);
  });
});
