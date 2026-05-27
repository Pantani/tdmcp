import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { extractAudioFeaturesImpl } from "../../src/tools/layer1/extractAudioFeatures.js";
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

describe("extractAudioFeaturesImpl", () => {
  it("builds a full four-band analysis chain: level + bass/mid/treble + merge + sensitivity + features", async () => {
    const bodies = captureCreateBodies();
    const result = await extractAudioFeaturesImpl(makeCtx(), {
      source: "device",
      bass_hz: 200,
      mid_hz: 1500,
      treble_hz: 4000,
      expose_controls: false,
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();
    // Source node.
    expect(bodies.some((b) => b.type === "audiodeviceinCHOP")).toBe(true);
    // One analyzeCHOP per band + one for overall level.
    const analyzers = bodies.filter((b) => b.type === "analyzeCHOP");
    expect(analyzers).toHaveLength(4);
    // Merge and sensitivity gain.
    expect(bodies.some((b) => b.name === "merged" && b.type === "mergeCHOP")).toBe(true);
    expect(bodies.some((b) => b.name === "sensitivity" && b.type === "mathCHOP")).toBe(true);
    // Final bind point.
    expect(bodies.some((b) => b.name === "features" && b.type === "nullCHOP")).toBe(true);
    // No image: output is a CHOP, not a TOP.
    expect(result.content.some((c) => c.type === "image")).toBe(false);
  });

  it("uses an audiooscillatorCHOP with whitenoise for the oscillator source", async () => {
    const bodies = captureCreateBodies();
    await extractAudioFeaturesImpl(makeCtx(), {
      source: "oscillator",
      bass_hz: 200,
      mid_hz: 1500,
      treble_hz: 4000,
      expose_controls: false,
      parent_path: "/project1",
    });
    const osc = bodies.find((b) => b.name === "audioin" && b.type === "audiooscillatorCHOP");
    expect(osc).toBeDefined();
    expect(osc?.parameters).toMatchObject({ wavetype: "whitenoise", amp: 0.5 });
  });

  it("uses audiofileinCHOP with play=1 for the file source", async () => {
    const bodies = captureCreateBodies();
    await extractAudioFeaturesImpl(makeCtx(), {
      source: "file",
      audio_file_path: "/audio/track.wav",
      bass_hz: 200,
      mid_hz: 1500,
      treble_hz: 4000,
      expose_controls: false,
      parent_path: "/project1",
    });
    const src = bodies.find((b) => b.name === "audioin" && b.type === "audiofileinCHOP");
    expect(src).toBeDefined();
    expect(src?.parameters).toMatchObject({ play: 1 });
  });

  it("exposes a Sensitivity float control bound to the gain CHOP when expose_controls is true", async () => {
    captureCreateBodies();
    const scripts = captureExecScripts();
    await extractAudioFeaturesImpl(makeCtx(), {
      source: "oscillator",
      bass_hz: 200,
      mid_hz: 1500,
      treble_hz: 4000,
      expose_controls: true,
      parent_path: "/project1",
    });
    const sensitivity = panelControls(scripts).find((c) => c.name === "Sensitivity");
    expect(sensitivity).toBeDefined();
    expect(sensitivity?.bind_to?.[0]).toMatch(/sensitivity\.gain$/);
  });

  it("mentions all four channels in the summary", async () => {
    captureCreateBodies();
    const result = await extractAudioFeaturesImpl(makeCtx(), {
      source: "device",
      bass_hz: 200,
      mid_hz: 1500,
      treble_hz: 4000,
      expose_controls: false,
      parent_path: "/project1",
    });
    const text = textOf(result);
    expect(text).toContain("level");
    expect(text).toContain("bass");
    expect(text).toContain("mid");
    expect(text).toContain("treble");
  });
});
