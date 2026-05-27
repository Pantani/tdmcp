import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { detectOnsetsImpl } from "../../src/tools/layer1/detectOnsets.js";
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

describe("detect_onsets", () => {
  it("builds an onset detector exposing kick/snare/hat pulse channels on a Null CHOP", async () => {
    const result = await detectOnsetsImpl(makeCtx(), {
      source: "oscillator",
      kick_hz: 120,
      snare_hz: 1500,
      hat_hz: 6000,
      threshold: 0.15,
      emit_events: false,
      expose_controls: false,
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("/project1/onsets/onsets");
    expect(text).toContain("kick");
    expect(text).toContain("snare");
    expect(text).toContain("hat");
  });

  it("returns a CHOP output (no preview image captured)", async () => {
    const result = await detectOnsetsImpl(makeCtx(), {
      source: "oscillator",
      kick_hz: 120,
      snare_hz: 1500,
      hat_hz: 6000,
      threshold: 0.15,
      emit_events: false,
      expose_controls: false,
      parent_path: "/project1",
    });
    // The output is a CHOP, so finalize must not attach an image content block.
    expect(result.content.some((c) => c.type === "image")).toBe(false);
  });

  it("builds each band from primitives (filter → analyze → lag → math → logic), never audioenvelope/pitch", async () => {
    const bodies = captureCreateBodies();
    await detectOnsetsImpl(makeCtx(), {
      source: "oscillator",
      kick_hz: 120,
      snare_hz: 1500,
      hat_hz: 6000,
      threshold: 0.2,
      emit_events: false,
      expose_controls: false,
      parent_path: "/project1",
    });
    const types = bodies.map((b) => b.type);
    // The forbidden ops must never appear.
    expect(types).not.toContain("audioenvelopeCHOP");
    expect(types).not.toContain("pitchCHOP");
    // The primitive onset chain must appear (three bands' worth).
    expect(types.filter((t) => t === "audiofilterCHOP")).toHaveLength(3);
    expect(types.filter((t) => t === "analyzeCHOP")).toHaveLength(3);
    expect(types.filter((t) => t === "logicCHOP")).toHaveLength(3);
    expect(types).toContain("lagCHOP");
    expect(types).toContain("mergeCHOP");
    expect(types).toContain("nullCHOP");

    // Threshold is the Logic CHOP's lower bound; the band filters carry the cutoffs.
    const gate = bodies.find((b) => b.name === "kick_gate");
    expect(gate?.type).toBe("logicCHOP");
    expect(gate?.parameters).toMatchObject({ convert: "bound", boundmin: 0.2 });
    const kickFilter = bodies.find((b) => b.name === "kick_filter");
    expect(kickFilter?.parameters).toMatchObject({ filter: "lowpass", cutofffrequency: 120 });
    const hatFilter = bodies.find((b) => b.name === "hat_filter");
    expect(hatFilter?.parameters).toMatchObject({ filter: "highpass", cutofffrequency: 6000 });
  });

  it("attaches a CHOP Execute DAT that broadcasts an onset event when emit_events is on", async () => {
    const bodies = captureCreateBodies();
    const scripts = captureExecScripts();
    const result = await detectOnsetsImpl(makeCtx(), {
      source: "oscillator",
      kick_hz: 120,
      snare_hz: 1500,
      hat_hz: 6000,
      threshold: 0.15,
      emit_events: true,
      expose_controls: false,
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();
    // The emitter must be a CHOP Execute DAT watching the onsets Null on value change.
    const emitter = bodies.find((b) => b.type === "chopexecuteDAT");
    expect(emitter?.name).toBe("onset_emitter");
    expect(emitter?.parameters).toMatchObject({ chop: "/project1/onsets/onsets", valuechange: 1 });
    // Its callback text must use the bridge broadcast mechanism for an `onset` event.
    const emitterScript = scripts.find(
      (s) => s.includes("onset_emitter") && s.includes("events.broadcast"),
    );
    expect(emitterScript).toBeDefined();
    expect(emitterScript).toContain("'onset'");
    expect(emitterScript).toContain("onValueChange");
  });

  it("omits the event emitter when emit_events is off", async () => {
    const bodies = captureCreateBodies();
    await detectOnsetsImpl(makeCtx(), {
      source: "oscillator",
      kick_hz: 120,
      snare_hz: 1500,
      hat_hz: 6000,
      threshold: 0.15,
      emit_events: false,
      expose_controls: false,
      parent_path: "/project1",
    });
    expect(bodies.some((b) => b.type === "chopexecuteDAT")).toBe(false);
  });

  it("exposes Sensitivity and Threshold knobs bound to the gain and all three gates", async () => {
    const scripts: string[] = [];
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        scripts.push(((await request.json()) as { script: string }).script);
        return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
      }),
    );
    await detectOnsetsImpl(makeCtx(), {
      source: "oscillator",
      kick_hz: 120,
      snare_hz: 1500,
      hat_hz: 6000,
      threshold: 0.15,
      emit_events: false,
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
    expect(sens?.bind_to?.[0]).toMatch(/sensitivity\.gain$/);
    const thresh = payload.controls.find((c) => c.name === "Threshold");
    // One knob retunes every band's gate threshold.
    expect(thresh?.bind_to).toHaveLength(3);
    expect(thresh?.bind_to?.every((t) => /_gate\.boundmin$/.test(t))).toBe(true);
  });

  it("reuses an existing CHOP as the source without creating an audio input node", async () => {
    const bodies = captureCreateBodies();
    await detectOnsetsImpl(makeCtx(), {
      source: "existing_chop",
      existing_chop_path: "/project1/my_audio",
      kick_hz: 120,
      snare_hz: 1500,
      hat_hz: 6000,
      threshold: 0.15,
      emit_events: false,
      expose_controls: false,
      parent_path: "/project1",
    });
    // No audio source node should be created when reusing an existing CHOP.
    const audioInputs = bodies.filter((b) =>
      ["audiodeviceinCHOP", "audiofileinCHOP", "audiooscillatorCHOP"].includes(b.type),
    );
    expect(audioInputs).toHaveLength(0);
  });
});
