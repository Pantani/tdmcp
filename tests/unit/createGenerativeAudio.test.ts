import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { createGenerativeAudioImpl } from "../../src/tools/layer1/createGenerativeAudio.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

interface CreatedNodeBody {
  parent_path: string;
  type: string;
  name?: string;
  parameters?: Record<string, unknown>;
}

interface PanelControl {
  name: string;
  type?: string;
  default?: unknown;
  bind_to?: string[];
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

function captureExecScripts(): string[] {
  const scripts: string[] = [];
  server.use(
    http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
      const body = (await request.json()) as { script: string };
      scripts.push(body.script);
      return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
    }),
  );
  return scripts;
}

function panelControls(scripts: string[]): PanelControl[] {
  const panel = scripts.find((s) => s.includes("appendCustomPage"));
  const b64 = /b64decode\("([^"]+)"\)/.exec(panel ?? "")?.[1];
  if (b64 === undefined) return [];
  const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as {
    controls: PanelControl[];
  };
  return payload.controls;
}

const BASE = { expose_controls: false, parent_path: "/project1" } as const;

describe("create_generative_audio", () => {
  it("builds a single oscillator → volume → null chain, with no preview image", async () => {
    const bodies = captureCreateBodies();
    const result = await createGenerativeAudioImpl(makeCtx(), {
      synth: "oscillator",
      frequency: 220,
      waveform: "sine",
      fm_ratio: 2,
      fm_depth: 100,
      volume: 0.5,
      to_device: false,
      ...BASE,
    });
    expect(result.isError).toBeFalsy();

    const osc = bodies.find((b) => b.name === "oscillator");
    expect(osc?.type).toBe("audiooscillatorCHOP");
    expect(osc?.parameters).toMatchObject({ wavetype: "sine", frequency: 220, amp: 1 });

    const volume = bodies.find((b) => b.name === "volume");
    expect(volume?.type).toBe("mathCHOP");
    expect(volume?.parameters).toMatchObject({ gain: 0.5 });

    expect(bodies.some((b) => b.name === "audio" && b.type === "nullCHOP")).toBe(true);
    // Audio signal output is a CHOP — no image.
    expect(result.content.some((c) => c.type === "image")).toBe(false);
  });

  it("maps friendly waveform names to the TD wavetype menu values", async () => {
    for (const [waveform, wavetype] of [
      ["triangle", "tri"],
      ["sawtooth", "ramp"],
      ["square", "square"],
    ] as const) {
      const bodies = captureCreateBodies();
      await createGenerativeAudioImpl(makeCtx(), {
        synth: "oscillator",
        frequency: 220,
        waveform,
        fm_ratio: 2,
        fm_depth: 100,
        volume: 0.5,
        to_device: false,
        ...BASE,
      });
      const osc = bodies.find((b) => b.name === "oscillator");
      expect(osc?.parameters).toMatchObject({ wavetype });
      server.resetHandlers();
    }
  });

  it("fm mode builds two oscillators plus a depth-scaling math CHOP at the ratio frequency", async () => {
    const bodies = captureCreateBodies();
    await createGenerativeAudioImpl(makeCtx(), {
      synth: "fm",
      frequency: 200,
      waveform: "sine",
      fm_ratio: 3,
      fm_depth: 150,
      volume: 0.5,
      to_device: false,
      ...BASE,
    });
    const oscillators = bodies.filter((b) => b.type === "audiooscillatorCHOP");
    expect(oscillators).toHaveLength(2);

    const modulator = bodies.find((b) => b.name === "modulator");
    // Modulator frequency = carrier base × ratio.
    expect(modulator?.parameters).toMatchObject({ frequency: 600 });
    const carrier = bodies.find((b) => b.name === "carrier");
    expect(carrier?.parameters).toMatchObject({ frequency: 200 });

    const fmScale = bodies.find((b) => b.name === "fm_scale");
    expect(fmScale?.type).toBe("mathCHOP");
    expect(fmScale?.parameters).toMatchObject({ gain: 150, postoff: 200 });
  });

  it("noise mode builds a Noise CHOP into a low-pass filter at the cutoff, no oscillator", async () => {
    const bodies = captureCreateBodies();
    await createGenerativeAudioImpl(makeCtx(), {
      synth: "noise",
      frequency: 800,
      waveform: "sine",
      fm_ratio: 2,
      fm_depth: 100,
      volume: 0.5,
      to_device: false,
      ...BASE,
    });
    expect(bodies.some((b) => b.type === "audiooscillatorCHOP")).toBe(false);
    expect(bodies.some((b) => b.name === "noise" && b.type === "noiseCHOP")).toBe(true);
    const filter = bodies.find((b) => b.name === "filter");
    expect(filter?.type).toBe("audiofilterCHOP");
    expect(filter?.parameters).toMatchObject({ filter: "lowpass", cutofffrequency: 800 });
  });

  it("noise mode exposes an (unbound) Frequency knob and drives the filter cutoff from it", async () => {
    captureCreateBodies();
    const scripts = captureExecScripts();
    await createGenerativeAudioImpl(makeCtx(), {
      synth: "noise",
      frequency: 800,
      waveform: "sine",
      fm_ratio: 2,
      fm_depth: 100,
      volume: 0.5,
      to_device: false,
      expose_controls: true,
      parent_path: "/project1",
    });

    // The documented Frequency knob exists in noise mode (previously only Volume was exposed),
    // and it is NOT bound: the filter cutoff reads it via an expression instead, so turning the
    // knob retunes the texture brightness rather than clobbering the cutoff expression.
    const controls = panelControls(scripts);
    const freq = controls.find((c) => c.name === "Frequency");
    expect(freq?.default).toBe(800);
    expect(freq?.bind_to).toBeUndefined();
    expect(controls.some((c) => c.name === "Volume")).toBe(true);

    // The filter's cutofffrequency becomes an abs' expression reading the container's Frequency
    // custom par (with the build-time value as a hasattr fallback).
    const cutoffExpr = scripts.find(
      (s) => s.includes("filter") && s.includes("cutofffrequency.expr"),
    );
    expect(cutoffExpr).toBeDefined();
    expect(cutoffExpr).toContain("par.Frequency");
    expect(cutoffExpr).toContain("hasattr");
    expect(cutoffExpr).toContain("else 800");
  });

  it("omits the audio device out by default and adds exactly one when to_device is true", async () => {
    const off = captureCreateBodies();
    await createGenerativeAudioImpl(makeCtx(), {
      synth: "oscillator",
      frequency: 220,
      waveform: "sine",
      fm_ratio: 2,
      fm_depth: 100,
      volume: 0.5,
      to_device: false,
      ...BASE,
    });
    expect(off.some((b) => b.type === "audiodeviceoutCHOP")).toBe(false);
    server.resetHandlers();

    const on = captureCreateBodies();
    await createGenerativeAudioImpl(makeCtx(), {
      synth: "oscillator",
      frequency: 220,
      waveform: "sine",
      fm_ratio: 2,
      fm_depth: 100,
      volume: 0.5,
      to_device: true,
      ...BASE,
    });
    expect(on.filter((b) => b.type === "audiodeviceoutCHOP")).toHaveLength(1);
  });

  it("exposes Frequency + Volume controls (plus FmRatio/FmDepth for fm) when expose_controls is on", async () => {
    captureCreateBodies();
    const scripts = captureExecScripts();
    await createGenerativeAudioImpl(makeCtx(), {
      synth: "fm",
      frequency: 220,
      waveform: "sine",
      fm_ratio: 2,
      fm_depth: 100,
      volume: 0.5,
      to_device: false,
      expose_controls: true,
      parent_path: "/project1",
    });
    const controls = panelControls(scripts);
    const freq = controls.find((c) => c.name === "Frequency");
    expect(freq?.default).toBe(220);
    expect(freq?.bind_to?.[0]).toMatch(/carrier\.frequency$/);

    const volume = controls.find((c) => c.name === "Volume");
    expect(volume?.bind_to?.[0]).toMatch(/volume\.gain$/);

    // FmRatio is exposed but NOT bound: the modulator frequency reads it via an expression
    // (Frequency × Fmratio) so it tracks carrier × ratio, instead of clobbering the
    // modulator frequency with the bare ratio value (~2 Hz).
    const fmRatio = controls.find((c) => c.name === "FmRatio");
    expect(fmRatio?.default).toBe(2);
    expect(fmRatio?.bind_to).toBeUndefined();

    const fmDepth = controls.find((c) => c.name === "FmDepth");
    expect(fmDepth?.default).toBe(100);
    expect(fmDepth?.bind_to?.[0]).toMatch(/fm_scale\.gain$/);
  });

  it("sets the modulator frequency to a carrier×ratio expression reading Frequency and Fmratio", async () => {
    captureCreateBodies();
    const scripts = captureExecScripts();
    await createGenerativeAudioImpl(makeCtx(), {
      synth: "fm",
      frequency: 220,
      waveform: "sine",
      fm_ratio: 2,
      fm_depth: 100,
      volume: 0.5,
      to_device: false,
      expose_controls: true,
      parent_path: "/project1",
    });
    // The modulator's frequency becomes an expression that multiplies the container's
    // Frequency and Fmratio custom pars (with the build-time values as fallbacks).
    const modExpr = scripts.find((s) => s.includes("modulator") && s.includes("frequency.expr"));
    expect(modExpr).toBeDefined();
    expect(modExpr).toContain("par.Frequency");
    expect(modExpr).toContain("par.Fmratio");
    expect(modExpr).toMatch(/\)\s*\*\s*\(/); // Frequency-expr * Fmratio-expr
  });

  it("notes the paused-timeline caveat in the summary", async () => {
    captureCreateBodies();
    const result = await createGenerativeAudioImpl(makeCtx(), {
      synth: "oscillator",
      frequency: 220,
      waveform: "sine",
      fm_ratio: 2,
      fm_depth: 100,
      volume: 0.5,
      to_device: false,
      ...BASE,
    });
    expect(textOf(result)).toMatch(/paused/i);
  });
});
