import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { detectTempoImpl } from "../../src/tools/layer1/detectTempo.js";
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

// Records every POST /api/nodes body so a test can assert what the builder created.
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

// Records every POST /api/exec script so a test can assert which Python steps ran.
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

describe("detect_tempo", () => {
  it("builds an auto-BPM detector exposing a `bpm` channel on a Null CHOP", async () => {
    const result = await detectTempoImpl(makeCtx(), {
      source: "synthetic",
      sensitivity: 0.5,
      min_bpm: 60,
      max_bpm: 200,
      drive_tempo: false,
      expose_controls: false,
      name: "detect_tempo",
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    // The Null bind point and the bpm channel must be reported.
    expect(text).toContain("/project1/detect_tempo/bpm");
    expect(text).toContain("bpm");
    // It is flagged experimental (lock quality needs live tuning).
    expect(text).toContain('"experimental": true');
  });

  it("returns a CHOP output (no preview image captured)", async () => {
    const result = await detectTempoImpl(makeCtx(), {
      source: "synthetic",
      sensitivity: 0.5,
      min_bpm: 60,
      max_bpm: 200,
      drive_tempo: false,
      expose_controls: false,
      name: "detect_tempo",
      parent_path: "/project1",
    });
    // The output is a CHOP, so finalize must not attach an image content block.
    expect(result.content.some((c) => c.type === "image")).toBe(false);
  });

  it("builds the onset chain from primitives (filter → analyze → lag → math → logic) + engine + constant + null", async () => {
    const bodies = captureCreateBodies();
    await detectTempoImpl(makeCtx(), {
      source: "synthetic",
      sensitivity: 0.5,
      min_bpm: 60,
      max_bpm: 200,
      drive_tempo: false,
      expose_controls: false,
      name: "detect_tempo",
      parent_path: "/project1",
    });
    const types = bodies.map((b) => b.type);
    // No invented tempo/beat-tap operator type.
    expect(types).not.toContain("beattapCHOP");
    expect(types).not.toContain("tempoCHOP");
    // The primitive onset chain + the BPM reduction tail must appear.
    expect(types).toContain("audiofilterCHOP");
    expect(types).toContain("analyzeCHOP");
    expect(types).toContain("lagCHOP");
    expect(types).toContain("logicCHOP");
    expect(types).toContain("chopexecuteDAT");
    expect(types).toContain("constantCHOP");
    expect(types).toContain("nullCHOP");

    // The beat band is a low-pass isolating the kick; the gate is a bound Logic CHOP.
    const filter = bodies.find((b) => b.name === "beat_filter");
    expect(filter?.type).toBe("audiofilterCHOP");
    expect(filter?.parameters).toMatchObject({ filter: "lowpass", cutofffrequency: 150 });
    const gate = bodies.find((b) => b.name === "beat_gate");
    expect(gate?.type).toBe("logicCHOP");
    expect(gate?.parameters).toMatchObject({ convert: "bound" });
    // The Constant CHOP that holds the latest BPM is named `bpm`.
    const constant = bodies.find((b) => b.name === "bpm_value");
    expect(constant?.type).toBe("constantCHOP");
    expect(constant?.parameters).toMatchObject({ name0: "bpm", value0: 0 });
  });

  it("derives the Logic gate boundmin from sensitivity (more sensitive → lower threshold)", async () => {
    const low = captureCreateBodies();
    await detectTempoImpl(makeCtx(), {
      source: "synthetic",
      sensitivity: 0.2,
      min_bpm: 60,
      max_bpm: 200,
      drive_tempo: false,
      expose_controls: false,
      name: "detect_tempo",
      parent_path: "/project1",
    });
    const lowThresh = low.find((b) => b.name === "beat_gate")?.parameters?.boundmin as number;

    server.resetHandlers();
    const high = captureCreateBodies();
    await detectTempoImpl(makeCtx(), {
      source: "synthetic",
      sensitivity: 0.9,
      min_bpm: 60,
      max_bpm: 200,
      drive_tempo: false,
      expose_controls: false,
      name: "detect_tempo",
      parent_path: "/project1",
    });
    const highThresh = high.find((b) => b.name === "beat_gate")?.parameters?.boundmin as number;

    // Higher sensitivity must yield a strictly lower onset threshold.
    expect(highThresh).toBeLessThan(lowThresh);
  });

  it("installs a CHOP Execute engine watching the pulse that medians intervals into a clamped BPM", async () => {
    const bodies = captureCreateBodies();
    const scripts = captureExecScripts();
    await detectTempoImpl(makeCtx(), {
      source: "synthetic",
      sensitivity: 0.5,
      min_bpm: 90,
      max_bpm: 180,
      drive_tempo: false,
      expose_controls: false,
      name: "detect_tempo",
      parent_path: "/project1",
    });
    // The engine is a CHOP Execute DAT watching the beat pulse on value change.
    const engine = bodies.find((b) => b.type === "chopexecuteDAT");
    expect(engine?.name).toBe("tempo_engine");
    expect(engine?.parameters).toMatchObject({
      chop: "/project1/detect_tempo/beat_pulse",
      valuechange: 1,
    });
    // The callback text must implement the BPM reduction.
    const engineScript = scripts.find(
      (s) => s.includes("tempo_engine") && s.includes("onValueChange"),
    );
    expect(engineScript).toBeDefined();
    // BPM = 60 / median(interval) and the clamp bounds are baked in.
    expect(engineScript).toContain("60.0 /");
    expect(engineScript).toContain("MIN_BPM = 90");
    expect(engineScript).toContain("MAX_BPM = 180");
    // It writes the Constant CHOP channel value.
    expect(engineScript).toContain("value0");
    // It reads the live Smoothing window length off the container.
    expect(engineScript).toContain("Smoothing");
  });

  it("only writes the global tempo when drive_tempo is on", async () => {
    // drive_tempo off → the engine must NOT touch op('/').time.tempo.
    const offScripts = captureExecScripts();
    await detectTempoImpl(makeCtx(), {
      source: "synthetic",
      sensitivity: 0.5,
      min_bpm: 60,
      max_bpm: 200,
      drive_tempo: false,
      expose_controls: false,
      name: "detect_tempo",
      parent_path: "/project1",
    });
    const offEngine = offScripts.find((s) => s.includes("tempo_engine"));
    expect(offEngine).toBeDefined();
    expect(offEngine).not.toContain("time.tempo");

    server.resetHandlers();
    // drive_tempo on → the engine writes op('/').time.tempo (the sync_external_clock write).
    const onScripts = captureExecScripts();
    await detectTempoImpl(makeCtx(), {
      source: "synthetic",
      sensitivity: 0.5,
      min_bpm: 60,
      max_bpm: 200,
      drive_tempo: true,
      expose_controls: false,
      name: "detect_tempo",
      parent_path: "/project1",
    });
    const onEngine = onScripts.find((s) => s.includes("tempo_engine"));
    expect(onEngine).toBeDefined();
    expect(onEngine).toContain("op('/').time.tempo = bpm");
  });

  it("pulls an existing CHOP in through a Select CHOP (no cross-container wire)", async () => {
    const bodies = captureCreateBodies();
    await detectTempoImpl(makeCtx(), {
      source: "existing",
      audio_in: "/project1/my_audio",
      sensitivity: 0.5,
      min_bpm: 60,
      max_bpm: 200,
      drive_tempo: false,
      expose_controls: false,
      name: "detect_tempo",
      parent_path: "/project1",
    });
    // No fresh audio source node should be created when reusing an existing CHOP.
    const audioInputs = bodies.filter((b) =>
      ["audiodeviceinCHOP", "audiofileinCHOP", "audiooscillatorCHOP", "beatCHOP"].includes(b.type),
    );
    expect(audioInputs).toHaveLength(0);
    // Instead, a Select CHOP inside the container references the external CHOP via its `chops`
    // par — TD rejects cross-container wires, so the source must be pulled in this way before it
    // can feed the beat filter.
    const select = bodies.find((b) => b.type === "selectCHOP" && b.name === "audioin");
    expect(select).toBeDefined();
    expect(select?.parameters?.chops).toBe("/project1/my_audio");
  });

  it("gates a tone with a Beat CHOP for the device-free synthetic source", async () => {
    const bodies = captureCreateBodies();
    await detectTempoImpl(makeCtx(), {
      source: "synthetic",
      sensitivity: 0.5,
      min_bpm: 60,
      max_bpm: 200,
      drive_tempo: false,
      expose_controls: false,
      name: "detect_tempo",
      parent_path: "/project1",
    });
    // A steady tone has no transients, so synthetic must gate a tone with a Beat CHOP pulse
    // to produce beat-rate onsets the detector can lock onto.
    expect(bodies.some((b) => b.type === "beatCHOP")).toBe(true);
    expect(bodies.some((b) => b.type === "audiooscillatorCHOP")).toBe(true);
  });

  it("carries the file path on the audio file-in node when source=file", async () => {
    const bodies = captureCreateBodies();
    await detectTempoImpl(makeCtx(), {
      source: "file",
      file: "/tracks/loop.wav",
      sensitivity: 0.5,
      min_bpm: 60,
      max_bpm: 200,
      drive_tempo: false,
      expose_controls: false,
      name: "detect_tempo",
      parent_path: "/project1",
    });
    const fileIn = bodies.find((b) => b.name === "audioin");
    expect(fileIn?.type).toBe("audiofileinCHOP");
    expect(fileIn?.parameters).toMatchObject({ file: "/tracks/loop.wav", play: 1 });
  });

  it("exposes Threshold (bound to the gate) and Smoothing knobs", async () => {
    const scripts = captureExecScripts();
    await detectTempoImpl(makeCtx(), {
      source: "synthetic",
      sensitivity: 0.5,
      min_bpm: 60,
      max_bpm: 200,
      drive_tempo: false,
      expose_controls: true,
      name: "detect_tempo",
      parent_path: "/project1",
    });
    const panel = scripts.find((s) => s.includes("appendCustomPage"));
    expect(panel).toBeDefined();
    const b64 = /b64decode\("([^"]+)"\)/.exec(panel ?? "")?.[1];
    if (b64 === undefined) throw new Error("panel script did not embed a base64 payload");
    const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as {
      controls: Array<{ name: string; bind_to?: string[] }>;
    };
    const thresh = payload.controls.find((c) => c.name === "Threshold");
    // The Threshold knob retunes the onset gate's lower bound.
    expect(thresh?.bind_to?.[0]).toMatch(/beat_gate\.boundmin$/);
    // Smoothing is exposed (read live by the engine; no node-parameter binding).
    const smooth = payload.controls.find((c) => c.name === "Smoothing");
    expect(smooth).toBeDefined();
  });

  it("orders the BPM clamp when min_bpm >= max_bpm instead of erroring", async () => {
    const scripts = captureExecScripts();
    const result = await detectTempoImpl(makeCtx(), {
      source: "synthetic",
      sensitivity: 0.5,
      min_bpm: 200,
      max_bpm: 90, // inverted on purpose
      drive_tempo: false,
      expose_controls: false,
      name: "detect_tempo",
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();
    // The engine's clamp must be re-ordered so MIN_BPM < MAX_BPM (no throw, valid bounds).
    const engineScript = scripts.find((s) => s.includes("tempo_engine"));
    const min = Number(/MIN_BPM = (\d+(?:\.\d+)?)/.exec(engineScript ?? "")?.[1]);
    const max = Number(/MAX_BPM = (\d+(?:\.\d+)?)/.exec(engineScript ?? "")?.[1]);
    expect(min).toBeLessThan(max);
  });
});
