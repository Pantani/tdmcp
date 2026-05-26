import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { applyPostProcessingImpl } from "../../src/tools/layer1/applyPostProcessing.js";
import { createAudioReactiveImpl } from "../../src/tools/layer1/createAudioReactive.js";
import { createDataVisualizationImpl } from "../../src/tools/layer1/createDataVisualization.js";
import { createParticleSystemImpl } from "../../src/tools/layer1/createParticleSystem.js";
import { setupOutputImpl } from "../../src/tools/layer1/setupOutput.js";
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

describe("layer 1 tool handlers", () => {
  describe("create_audio_reactive", () => {
    it("builds a GLSL audio-reactive system", async () => {
      const result = await createAudioReactiveImpl(makeCtx(), {
        audio_source: "microphone",
        visual_style: "glsl",
        frequency_bands: 8,
        beat_detection: true,
        parent_path: "/project1",
      });
      expect(result.isError).toBeFalsy();
      const text = textOf(result);
      expect(text).toContain("/project1/audio_reactive");
      expect(text).toContain("/project1/audio_reactive/out1");
      expect(text).toContain("style: glsl");
    });

    it("builds a geometric audio-reactive system", async () => {
      const result = await createAudioReactiveImpl(makeCtx(), {
        audio_source: "microphone",
        visual_style: "geometric",
        frequency_bands: 8,
        beat_detection: true,
        parent_path: "/project1",
      });
      expect(result.isError).toBeFalsy();
      const text = textOf(result);
      expect(text).toContain("/project1/audio_reactive");
      expect(text).toContain("/project1/audio_reactive/out1");
      expect(text).toContain("style: geometric");
    });

    // Records every POST /api/nodes body so a test can assert what parameters a
    // builder asked the bridge to set on a node.
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

    it("caps the spectrum output length so the CHOP-to-TOP texture stays within GPU limits", async () => {
      const bodies = captureCreateBodies();
      await createAudioReactiveImpl(makeCtx(), {
        audio_source: "microphone",
        visual_style: "glsl",
        frequency_bands: 8,
        beat_detection: true,
        parent_path: "/project1",
      });
      const spectrum = bodies.find((b) => b.name === "spectrum");
      expect(spectrum?.type).toBe("audiospectrumCHOP");
      // "matchtofrequency" (the TD default) would emit ~22050 samples and overflow the
      // 16384 max texture width; "setmanually" + a bounded outlength keeps it in range.
      expect(spectrum?.parameters).toMatchObject({ outputmenu: "setmanually", outlength: 128 });
    });

    it.each([
      [8, 128], // below TD's 128 minimum → clamped up
      [512, 512], // inside the valid range → passed through
      [99999, 4096], // above TD's 4096 maximum → clamped down
    ])("clamps spectrum outlength into TD's 128–4096 range (bands=%i → %i)", async (bands, want) => {
      const bodies = captureCreateBodies();
      await createAudioReactiveImpl(makeCtx(), {
        audio_source: "microphone",
        visual_style: "glsl",
        frequency_bands: bands,
        beat_detection: false,
        parent_path: "/project1",
      });
      const spectrum = bodies.find((b) => b.name === "spectrum");
      expect(spectrum?.parameters?.outlength).toBe(want);
    });
  });

  describe("create_particle_system", () => {
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

    it("builds a particle system inside a container", async () => {
      const result = await createParticleSystemImpl(makeCtx(), {
        emitter_shape: "point",
        particle_count: 10000,
        forces: ["noise", "gravity"],
        render_style: "sprites",
        lifetime: 3,
        parent_path: "/project1",
      });
      expect(result.isError).toBeFalsy();
      const text = textOf(result);
      expect(text).toContain("/project1/particle_system");
      expect(text).toContain("/project1/particle_system/out1");
    });

    it("strips the geometryCOMP's default torus before populating it", async () => {
      const scripts = captureExecScripts();
      await createParticleSystemImpl(makeCtx(), {
        emitter_shape: "point",
        particle_count: 10000,
        forces: ["noise", "gravity"],
        render_style: "sprites",
        lifetime: 3,
        parent_path: "/project1",
      });
      // A fresh geometryCOMP ships with a default torus1 that would render over the
      // particles; the builder must clear the COMP's children right after creating it.
      const cleared = scripts.some((s) => s.includes(".children") && s.includes(".destroy()"));
      expect(cleared).toBe(true);
    });
  });

  describe("apply_post_processing", () => {
    it("applies a direct effect (bloom)", async () => {
      const result = await applyPostProcessingImpl(makeCtx(), {
        source_path: "/project1/render",
        effects: ["bloom"],
        parent_path: "/project1",
      });
      expect(result.isError).toBeFalsy();
      const text = textOf(result);
      expect(text).toContain("/project1/post_fx");
      expect(text).toContain("/project1/post_fx/out1");
      expect(text).toContain("Applied 1/1");
    });

    it("applies a GLSL effect (rgb_split)", async () => {
      const result = await applyPostProcessingImpl(makeCtx(), {
        source_path: "/project1/render",
        effects: ["rgb_split"],
        parent_path: "/project1",
      });
      expect(result.isError).toBeFalsy();
      const text = textOf(result);
      expect(text).toContain("/project1/post_fx");
      expect(text).toContain("/project1/post_fx/out1");
      expect(text).toContain("Applied 1/1");
    });
  });

  describe("setup_output", () => {
    it("configures a window output", async () => {
      const result = await setupOutputImpl(makeCtx(), {
        source_path: "/project1/out1",
        output_type: "window",
        resolution: "1080p",
        parent_path: "/project1",
      });
      expect(result.isError).toBeFalsy();
      const text = textOf(result);
      expect(text).toContain("/project1/window_out");
      expect(text).toContain("window output");
    });

    it("configures an NDI output", async () => {
      const result = await setupOutputImpl(makeCtx(), {
        source_path: "/project1/out1",
        output_type: "ndi",
        resolution: "1080p",
        parent_path: "/project1",
      });
      expect(result.isError).toBeFalsy();
      const text = textOf(result);
      expect(text).toContain("/project1/ndi_out");
      expect(text).toContain("ndi output");
    });
  });

  describe("create_data_visualization", () => {
    it("builds a data visualization", async () => {
      const result = await createDataVisualizationImpl(makeCtx(), {
        data_source: "table",
        chart_style: "bars",
        parent_path: "/project1",
      });
      expect(result.isError).toBeFalsy();
      const text = textOf(result);
      expect(text).toContain("/project1/data_viz");
      expect(text).toContain("/project1/data_viz/out1");
    });
  });
});
