import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { createAudioReactiveImpl } from "../../src/tools/layer1/createAudioReactive.js";
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

describe("createAudioReactiveImpl", () => {
  it("builds the full audio-reactive chain with spectrum, choptoTOP, glslTOP visual, and out1", async () => {
    const bodies = captureCreateBodies();
    const result = await createAudioReactiveImpl(makeCtx(), {
      audio_source: "microphone",
      visual_style: "glsl",
      frequency_bands: 8,
      beat_detection: false,
      expose_controls: false,
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();
    expect(bodies.some((b) => b.type === "audiodeviceinCHOP")).toBe(true);
    expect(bodies.some((b) => b.name === "spectrum" && b.type === "audiospectrumCHOP")).toBe(true);
    expect(bodies.some((b) => b.name === "level" && b.type === "analyzeCHOP")).toBe(true);
    expect(bodies.some((b) => b.name === "audio_tex" && b.type === "choptoTOP")).toBe(true);
    // Fixed-size GLSL canvas for the spectrum visual.
    const visual = bodies.find((b) => b.name === "visual" && b.type === "glslTOP");
    expect(visual).toBeDefined();
    expect(visual?.parameters).toMatchObject({ resolutionw: 1280, resolutionh: 720 });
    expect(bodies.some((b) => b.name === "out1" && b.type === "nullTOP")).toBe(true);
    // A preview image should be captured (TOP output).
    expect(result.content.some((c) => c.type === "image")).toBe(true);
  });

  it("adds a beatCHOP when beat_detection is true", async () => {
    const bodies = captureCreateBodies();
    await createAudioReactiveImpl(makeCtx(), {
      audio_source: "microphone",
      visual_style: "glsl",
      frequency_bands: 8,
      beat_detection: true,
      expose_controls: false,
      parent_path: "/project1",
    });
    expect(bodies.some((b) => b.name === "beat" && b.type === "beatCHOP")).toBe(true);
  });

  it("omits the beatCHOP when beat_detection is false", async () => {
    const bodies = captureCreateBodies();
    await createAudioReactiveImpl(makeCtx(), {
      audio_source: "microphone",
      visual_style: "glsl",
      frequency_bands: 8,
      beat_detection: false,
      expose_controls: false,
      parent_path: "/project1",
    });
    expect(bodies.some((b) => b.type === "beatCHOP")).toBe(false);
  });

  it("uses audiofileinCHOP with play=1 for the file source", async () => {
    const bodies = captureCreateBodies();
    await createAudioReactiveImpl(makeCtx(), {
      audio_source: "file",
      audio_file_path: "/audio/track.wav",
      visual_style: "glsl",
      frequency_bands: 8,
      beat_detection: false,
      expose_controls: false,
      parent_path: "/project1",
    });
    const src = bodies.find((b) => b.name === "audioin" && b.type === "audiofileinCHOP");
    expect(src).toBeDefined();
    expect(src?.parameters).toMatchObject({ play: 1 });
  });

  it("exposes a Sensitivity float control bound to the levelTOP sensitivity.brightness1", async () => {
    captureCreateBodies();
    const scripts = captureExecScripts();
    await createAudioReactiveImpl(makeCtx(), {
      audio_source: "microphone",
      visual_style: "glsl",
      frequency_bands: 8,
      beat_detection: false,
      expose_controls: true,
      parent_path: "/project1",
    });
    const ctrl = panelControls(scripts).find((c) => c.name === "Sensitivity");
    expect(ctrl).toBeDefined();
    expect(ctrl?.bind_to?.[0]).toMatch(/sensitivity\.brightness1$/);
  });

  it("includes source and style in the summary text", async () => {
    captureCreateBodies();
    const result = await createAudioReactiveImpl(makeCtx(), {
      audio_source: "microphone",
      visual_style: "geometric",
      frequency_bands: 16,
      beat_detection: false,
      expose_controls: false,
      parent_path: "/project1",
    });
    const text = textOf(result);
    expect(text).toContain("microphone");
    expect(text).toContain("geometric");
    expect(text).toContain("16");
  });
});
