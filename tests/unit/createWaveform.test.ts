import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { createWaveformImpl } from "../../src/tools/layer1/createWaveform.js";
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

// Records every POST /api/nodes body so a test can assert what the builder created and
// with which parameters. Echoes a deterministic path back so the build proceeds.
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

describe("create_waveform", () => {
  it("builds a waveform oscilloscope inside a container with a Null TOP output", async () => {
    const result = await createWaveformImpl(makeCtx(), {
      source: "oscillator",
      color: "#00ff88",
      scale: 1,
      time_window: 1,
      expose_controls: false,
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("/project1/waveform");
    expect(text).toContain("/project1/waveform/out1");
    expect(text).toContain("source: oscillator");
  });

  it("creates a Trail CHOP (scrolling buffer) and a CHOP-to-SOP scope line rendered via Geo + Camera + Render TOP", async () => {
    const bodies = captureCreateBodies();
    await createWaveformImpl(makeCtx(), {
      source: "oscillator",
      color: "#00ff88",
      scale: 1,
      time_window: 1,
      expose_controls: false,
      parent_path: "/project1",
    });
    const trail = bodies.find((b) => b.type === "trailCHOP");
    expect(trail?.name).toBe("trail");
    // The render path is now a real oscilloscope LINE: the resampled CHOP becomes points of a
    // SOP polyline (CHOP-to-SOP), a Geometry COMP renders it through an orthographic Camera and
    // a Render TOP. There is no longer a CHOP-to-TOP brightness strip.
    expect(bodies.some((b) => b.type === "choptoTOP")).toBe(false);
    const line = bodies.find((b) => b.type === "choptoSOP");
    expect(line?.name).toBe("line");
    expect(bodies.some((b) => b.type === "geometryCOMP")).toBe(true);
    expect(bodies.some((b) => b.type === "cameraCOMP")).toBe(true);
    expect(bodies.some((b) => b.type === "renderTOP")).toBe(true);
    expect(bodies.some((b) => b.type === "constantMAT")).toBe(true);
  });

  it("renders the scope line through an orthographic camera with the Render TOP reading geo/camera/lights by parameter", async () => {
    const bodies = captureCreateBodies();
    await createWaveformImpl(makeCtx(), {
      source: "oscillator",
      color: "#00ff88",
      scale: 1,
      time_window: 1,
      expose_controls: false,
      parent_path: "/project1",
    });
    // Orthographic projection keeps the trace's true shape (no perspective bow).
    const cam = bodies.find((b) => b.type === "cameraCOMP");
    expect(cam?.parameters).toMatchObject({ projection: "ortho" });
    // Render TOP wires its scene through params, not connectors (mirrors create_3d_scene).
    const render = bodies.find((b) => b.type === "renderTOP");
    const geo = bodies.find((b) => b.type === "geometryCOMP");
    expect(render?.parameters?.camera).toBe(cam ? "/project1/waveform/cam" : undefined);
    expect(render?.parameters?.geometry).toBe(geo ? "/project1/waveform/geo" : undefined);
  });

  it("renames the signal channel to 'ty' so CHOP-to-SOP deflects each point's Y (default mode auto-spreads X)", async () => {
    const bodies = captureCreateBodies();
    await createWaveformImpl(makeCtx(), {
      source: "oscillator",
      color: "#00ff88",
      scale: 1,
      time_window: 1,
      expose_controls: false,
      parent_path: "/project1",
    });
    // CHOP-to-SOP maps a channel named "ty" to each point's Y-translate (the vertical deflection);
    // in default mode it auto-spreads the points across X in [-1, 1]. (Live-verified: a "ty" channel
    // deflects Y and X auto-spreads; setting startposx/endposx would OVERRIDE the deflection and
    // flatten the line — so the SOP is left in default mode with no position params.)
    const ypos = bodies.find((b) => b.type === "renameCHOP" && b.name === "ypos");
    expect(ypos?.parameters).toMatchObject({ renamefrom: "*", renameto: "ty" });
    const line = bodies.find((b) => b.type === "choptoSOP");
    expect(line?.name).toBe("line");
    // No explicit position overrides (they would defeat the ty-driven deflection).
    expect(line?.parameters?.startposx).toBeUndefined();
    expect(line?.parameters?.attscope).toBeUndefined();
  });

  it("sets the Trail CHOP window length from time_window in seconds", async () => {
    const bodies = captureCreateBodies();
    await createWaveformImpl(makeCtx(), {
      source: "oscillator",
      color: "#00ff88",
      scale: 1,
      time_window: 2.5,
      expose_controls: false,
      parent_path: "/project1",
    });
    const trail = bodies.find((b) => b.type === "trailCHOP");
    // Window Length is `wlength`; `wlengthunit` switches the units to seconds so
    // time_window reads directly as a duration.
    expect(trail?.parameters).toMatchObject({ wlength: 2.5, wlengthunit: "seconds" });
  });

  it("ingests the CHOP into the CHOP-to-SOP via its `chop` source parameter (not a wire)", async () => {
    // CHOP to SOP reads its source from a `chop` PARAMETER (a path reference), like
    // top-to-CHOP's `top`. The builder must PATCH that parameter rather than wiring it.
    let choptoSopChopParam: unknown;
    const created: CreatedNodeBody[] = [];
    server.use(
      http.post(`${TD_BASE}/api/nodes`, async ({ request }) => {
        const body = (await request.json()) as CreatedNodeBody;
        created.push(body);
        const name = body.name ?? `${body.type.replace(/[^a-zA-Z0-9]/g, "").toLowerCase()}1`;
        return HttpResponse.json({
          ok: true,
          data: { path: `${body.parent_path}/${name}`, type: body.type, name },
        });
      }),
      http.patch(`${TD_BASE}/api/nodes/:seg`, async ({ request }) => {
        const body = (await request.json()) as { parameters: Record<string, unknown> };
        if ("chop" in body.parameters) choptoSopChopParam = body.parameters.chop;
        return HttpResponse.json({ ok: true, data: { parameters: body.parameters } });
      }),
    );
    await createWaveformImpl(makeCtx(), {
      source: "oscillator",
      color: "#00ff88",
      scale: 1,
      time_window: 1,
      expose_controls: false,
      parent_path: "/project1",
    });
    // The Trail feeds a Resample (downsample to a fixed display width) which feeds the line,
    // so the CHOP-to-SOP's `chop` source param must point at the rename node (whose "P(1)"
    // channel drives the Y deflection).
    expect(choptoSopChopParam).toBe("/project1/waveform/ypos");
  });

  it("builds an oscillator source (the device-free test path) without an audio device node", async () => {
    const bodies = captureCreateBodies();
    await createWaveformImpl(makeCtx(), {
      source: "oscillator",
      color: "#00ff88",
      scale: 1,
      time_window: 1,
      expose_controls: false,
      parent_path: "/project1",
    });
    expect(bodies.some((b) => b.type === "audiooscillatorCHOP")).toBe(true);
    expect(bodies.some((b) => b.type === "audiodeviceinCHOP")).toBe(false);
  });

  it("uses the live audio device for the default source", async () => {
    const bodies = captureCreateBodies();
    await createWaveformImpl(makeCtx(), {
      source: "device",
      color: "#00ff88",
      scale: 1,
      time_window: 1,
      expose_controls: false,
      parent_path: "/project1",
    });
    expect(bodies.some((b) => b.type === "audiodeviceinCHOP")).toBe(true);
  });

  it("exposes Color / Scale / TimeWindow controls bound to the right params when expose_controls is on", async () => {
    const scripts: string[] = [];
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        scripts.push(((await request.json()) as { script: string }).script);
        return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
      }),
    );
    await createWaveformImpl(makeCtx(), {
      source: "oscillator",
      color: "#00ff88",
      scale: 1,
      time_window: 1,
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
    const names = payload.controls.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(["Color", "Scale", "TimeWindow"]));
    const scale = payload.controls.find((c) => c.name === "Scale");
    expect(scale?.bind_to?.[0]).toMatch(/scale\.gain$/);
    const timeWindow = payload.controls.find((c) => c.name === "TimeWindow");
    expect(timeWindow?.bind_to?.[0]).toMatch(/trail\.wlength$/);
  });

  it("reuses an existing CHOP without creating any audio source node", async () => {
    const bodies = captureCreateBodies();
    const result = await createWaveformImpl(makeCtx(), {
      source: "existing_chop",
      existing_chop_path: "/project1/my_audio",
      color: "#00ff88",
      scale: 1,
      time_window: 1,
      expose_controls: false,
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();
    expect(bodies.some((b) => /^audio/.test(b.type))).toBe(false);
  });
});
