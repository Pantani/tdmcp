import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { create3dAudioReactiveImpl } from "../../src/tools/layer1/create3dAudioReactive.js";
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

// Records PATCH parameter bodies so tests can assert params set after node creation
// (e.g. the Geometry COMP's instancing parameters).
function capturePatchParams(): Array<Record<string, unknown>> {
  const patched: Array<Record<string, unknown>> = [];
  server.use(
    http.patch(`${TD_BASE}/api/nodes/:seg`, async ({ request }) => {
      const body = (await request.json()) as { parameters: Record<string, unknown> };
      patched.push(body.parameters);
      return HttpResponse.json({
        ok: true,
        data: { path: "/p", type: "geometryCOMP", name: "geo", parameters: body.parameters },
      });
    }),
  );
  return patched;
}

describe("create_3d_audio_reactive", () => {
  it("builds the FFT spectrum → instanced-bar geometry chain", async () => {
    const bodies = captureCreateBodies();
    const patched = capturePatchParams();
    const result = await create3dAudioReactiveImpl(makeCtx(), {
      source: "oscillator",
      mode: "instanced_bars",
      bands: 16,
      primitive: "box",
      spin: 0,
      expose_controls: true,
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();

    // Audio source + FFT spectrum tail.
    expect(bodies.some((b) => b.name === "audioin" && b.type === "audiooscillatorCHOP")).toBe(true);
    expect(bodies.some((b) => b.name === "spectrum_fft" && b.type === "audiospectrumCHOP")).toBe(
      true,
    );
    const rebin = bodies.find((b) => b.name === "rebin");
    expect(rebin?.type).toBe("resampleCHOP");
    // Rebinned toward `bands` samples (0..bands-1) — one sample per bar feeds the instancer.
    expect(rebin?.parameters).toMatchObject({ start: 0, end: 15, startunit: "samples" });

    // Geometry COMP + the rendered bar primitive inside it.
    expect(bodies.some((b) => b.name === "geo" && b.type === "geometryCOMP")).toBe(true);
    const bar = bodies.find((b) => b.name === "bar");
    expect(bar?.type).toBe("boxSOP");
    expect(bar?.parent_path).toMatch(/\/audio3d\/geo$/);

    // The instance source is a CHOP: one sample per bar carrying a `tx` (position) and `sy`
    // (height) channel. A pattern ramp lays the row out along X; a merge combines tx + sy.
    const barx = bodies.find((b) => b.name === "bar_x");
    expect(barx?.type).toBe("patternCHOP");
    expect(barx?.parameters).toMatchObject({ wavetype: "ramp", channelname: "tx" });
    expect(bodies.some((b) => b.name === "bar_sy" && b.type === "renameCHOP")).toBe(true);
    expect(bodies.some((b) => b.name === "bar_inst" && b.type === "mergeCHOP")).toBe(true);

    // The Geometry COMP is switched into instancing, reading tx/sy by channel name from the CHOP
    // (per-instance height is a channel, not a once-evaluated expression).
    const inst = patched.find((p) => p.instancing !== undefined);
    expect(inst).toMatchObject({ instancing: 1, instancetx: "tx", instancesy: "sy" });
    expect(String(inst?.instanceop)).toMatch(/\/bar_inst$/);
    // No SOP point grid in the CHOP-instancing design.
    expect(bodies.some((b) => b.name === "points")).toBe(false);

    // Render TOP reads its scene from parameters; output Null is a TOP with a preview.
    const render = bodies.find((b) => b.name === "render");
    expect(render?.type).toBe("renderTOP");
    expect(String(render?.parameters?.geometry)).toMatch(/\/geo$/);
    expect(bodies.some((b) => b.name === "out1" && b.type === "nullTOP")).toBe(true);
    expect(result.content.some((c) => c.type === "image")).toBe(true);
  });

  it("drives per-bar height from the spectrum via a `sy` instance channel", async () => {
    const bodies = captureCreateBodies();
    const patched = capturePatchParams();
    await create3dAudioReactiveImpl(makeCtx(), {
      source: "oscillator",
      mode: "instanced_bars",
      bands: 8,
      primitive: "box",
      spin: 0,
      expose_controls: false,
      parent_path: "/project1",
    });
    // The spectrum magnitudes are lifted by a Math gain, then renamed to the `sy` channel.
    expect(bodies.some((b) => b.name === "bar_height" && b.type === "mathCHOP")).toBe(true);
    const sy = bodies.find((b) => b.name === "bar_sy");
    expect(sy?.parameters).toMatchObject({ renameto: "sy" });
    // Per-bar height is read as a channel name (not a once-evaluated expression).
    const inst = patched.find((p) => p.instancesy !== undefined);
    expect(inst?.instancesy).toBe("sy");
  });

  it("uses a single rendered primitive (no instance grid) in bass_pulse mode", async () => {
    const bodies = captureCreateBodies();
    const result = await create3dAudioReactiveImpl(makeCtx(), {
      source: "oscillator",
      mode: "bass_pulse",
      bands: 16,
      primitive: "sphere",
      spin: 0,
      expose_controls: false,
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();

    // The pulsing object is a single primitive — no instance points grid.
    const bar = bodies.find((b) => b.name === "bar");
    expect(bar?.type).toBe("sphereSOP");
    expect(bodies.some((b) => b.name === "points")).toBe(false);

    // A bass-energy analysis drives the swell, and the chain still renders to a TOP.
    expect(bodies.some((b) => b.name === "bass" && b.type === "analyzeCHOP")).toBe(true);
    expect(bodies.some((b) => b.name === "out1" && b.type === "nullTOP")).toBe(true);
    expect(result.content.some((c) => c.type === "image")).toBe(true);
  });

  it("spins the whole scene with a geo.ry expression when spin > 0", async () => {
    const scripts: string[] = [];
    captureCreateBodies();
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script: string };
        scripts.push(body.script);
        return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
      }),
    );
    await create3dAudioReactiveImpl(makeCtx(), {
      source: "oscillator",
      mode: "bass_pulse",
      bands: 16,
      primitive: "box",
      spin: 45,
      expose_controls: false,
      parent_path: "/project1",
    });
    expect(scripts.some((s) => s.includes("ry.expr") && s.includes("absTime.seconds * 45"))).toBe(
      true,
    );
  });
});
