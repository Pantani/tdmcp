import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  createImageToParticlesImpl,
  createImageToParticlesSchema,
} from "../../src/tools/layer1/createImageToParticles.js";
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

function panelControls(scripts: string[]): PanelControl[] {
  const panel = scripts.find((s) => s.includes("appendCustomPage"));
  const b64 = /b64decode\("([^"]+)"\)/.exec(panel ?? "")?.[1];
  if (b64 === undefined) return [];
  const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as {
    controls: PanelControl[];
  };
  return payload.controls;
}

const defaults = createImageToParticlesSchema.parse({});

describe("image_to_particles", () => {
  it("builds the default Banana.tif network at 192×192 with image-mode colour", async () => {
    const bodies = captureCreateBodies();
    const scripts = captureExecScripts();
    const patched = capturePatchParams();
    const result = await createImageToParticlesImpl(makeCtx(), defaults);
    expect(result.isError).toBeFalsy();

    // moviefileinTOP "src" gets the @sample sentinel as raw value; the impl then runs an exec
    // script that rewrites par.file to app.samplesFolder + the rel path. Live-verified TD 099
    // requires the absolute path — bare names + ${TOUCH}/${TD_INSTALL} tokens don't resolve.
    const src = bodies.find((b) => b.name === "src");
    expect(src?.type).toBe("moviefileinTOP");
    expect(src?.parameters?.file).toBe("@sample/Map/Banana.tif");
    expect(
      scripts.some((s) => s.includes("app.samplesFolder") && s.includes("Map/Banana.tif")),
    ).toBe(true);

    // resolutionTOP sized 192×192.
    const resampled = bodies.find((b) => b.name === "src_resampled");
    expect(resampled?.type).toBe("resolutionTOP");
    expect(resampled?.parameters).toMatchObject({
      outputresolution: "custom",
      resolution1: 192,
      resolution2: 192,
    });

    // Three GLSL TOPs, each rgba32float 192×192, each with partnered textDAT + pixeldat.
    for (const name of ["rest_pos", "vel_update", "pos_update"]) {
      const t = bodies.find((b) => b.name === name);
      expect(t?.type).toBe("glslTOP");
      expect(t?.parameters).toMatchObject({
        format: "rgba32float",
        resolutionw: 192,
        resolutionh: 192,
      });
    }
    for (const frag of ["rest_frag", "vel_frag", "pos_frag"]) {
      expect(bodies.some((b) => b.name === frag && b.type === "textDAT")).toBe(true);
      expect(scripts.some((s) => s.includes("pixeldat") && s.includes(frag))).toBe(true);
    }

    // Both feedbacks closed via par.top.
    expect(scripts.some((s) => s.includes(".par.top") && s.includes("vel_update"))).toBe(true);
    expect(scripts.some((s) => s.includes(".par.top") && s.includes("pos_update"))).toBe(true);

    // Live-verified TD 099 gotcha: feedbackTOPs need (a) forced resolution and (b) a wired
    // input source or they error "Not enough sources specified". Both vel_fb and pos_fb are
    // created with bufParams (rgba32float 192×192) and receive their update TOP as input 0.
    for (const name of ["vel_fb", "pos_fb"]) {
      const fb = bodies.find((b) => b.name === name);
      expect(fb?.type).toBe("feedbackTOP");
      expect(fb?.parameters).toMatchObject({
        format: "rgba32float",
        resolutionw: 192,
        resolutionh: 192,
      });
    }

    // Geometry COMP instancing.
    const inst = patched.find((p) => p.instancing !== undefined);
    expect(inst).toMatchObject({
      instancing: 1,
      instancetx: "r",
      instancety: "g",
      instancetz: "b",
    });
    // Default audio_source='none' binds instancing directly to rest_pos (static case) — the
    // feedback pos_update chain only takes over when audio_source != 'none', because TD's
    // par.top-driven feedbackTOPs return black on first cooks and would collapse the field
    // (live-verified TD 099).
    expect(String(inst?.instanceop)).toMatch(/\/rest_pos$/);
    expect(String(inst?.instancetop)).toMatch(/\/rest_pos$/);
    // image mode → colour instancing set via a separate try-block exec (live-verified TD 099
    // names: instancecolorop + instancer/g/b), not on the atomic setParams dict. This split
    // is required so a colour-par failure can't roll back the transform-instancing dict.
    expect(inst?.instancecolorop).toBeUndefined();
    expect(
      scripts.some(
        (s) => s.includes("instancecolorop") && s.includes("src_resampled") && s.includes("try:"),
      ),
    ).toBe(true);

    // No audio chain on default (audio_source='none').
    expect(bodies.some((b) => b.name === "react_level")).toBe(false);
    expect(bodies.some((b) => b.type === "audiodeviceinCHOP")).toBe(false);
    expect(bodies.some((b) => b.type === "audiofileinCHOP")).toBe(false);

    // Output null + preview image.
    expect(bodies.some((b) => b.name === "out1" && b.type === "nullTOP")).toBe(true);
    expect(result.content.some((c) => c.type === "image")).toBe(true);

    const controls = panelControls(scripts).map((c) => c.name);
    expect(controls).toEqual(["PointSize", "Springstiff", "Scatterstr", "Damp", "Zoom"]);

    // Summary text references the particle count = 192².
    const text = result.content.find((c) => c.type === "text");
    expect(text?.type === "text" && text.text).toContain(String(192 * 192));
  });

  it("references an external TOP without creating a moviefilein when source.kind='top'", async () => {
    const bodies = captureCreateBodies();
    const result = await createImageToParticlesImpl(makeCtx(), {
      ...defaults,
      source: { kind: "top", path: "/project1/movieIn" },
    });
    expect(result.isError).toBeFalsy();
    expect(bodies.some((b) => b.type === "moviefileinTOP")).toBe(false);
    // Still creates the resampled TOP.
    expect(bodies.some((b) => b.name === "src_resampled")).toBe(true);
  });

  it("wires an audiofileinCHOP → analyzeCHOP → react_level null when audio_source='file'", async () => {
    const bodies = captureCreateBodies();
    const scripts = captureExecScripts();
    const result = await createImageToParticlesImpl(makeCtx(), {
      ...defaults,
      audio_source: "file",
      audio_file: "track.wav",
    });
    expect(result.isError).toBeFalsy();
    const audioIn = bodies.find((b) => b.name === "audio_in");
    expect(audioIn?.type).toBe("audiofileinCHOP");
    expect(audioIn?.parameters?.file).toBe("track.wav");
    expect(bodies.some((b) => b.name === "audio_rms" && b.type === "analyzeCHOP")).toBe(true);
    expect(bodies.some((b) => b.name === "react_level" && b.type === "nullCHOP")).toBe(true);
    // uReact uniform expression bound to react_level.
    expect(
      scripts.some((s) => s.includes('vec0name = "uReact"') && s.includes("react_level")),
    ).toBe(true);
  });

  it("omits per-instance colour when color_mode='mono'", async () => {
    const patched = capturePatchParams();
    const scripts = captureExecScripts();
    captureCreateBodies();
    const result = await createImageToParticlesImpl(makeCtx(), {
      ...defaults,
      color_mode: "mono",
    });
    expect(result.isError).toBeFalsy();
    const inst = patched.find((p) => p.instancing !== undefined);
    expect(inst?.instancecolorop).toBeUndefined();
    // No colour-instancing try-block emitted in mono mode.
    expect(scripts.some((s) => s.includes("instancecolorop"))).toBe(false);
  });

  it("rejects side out of range", () => {
    expect(() => createImageToParticlesSchema.parse({ side: 8 })).toThrow();
    expect(() => createImageToParticlesSchema.parse({ side: 1024 })).toThrow();
  });
});
