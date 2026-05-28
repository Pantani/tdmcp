import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { scaffoldGenreImpl } from "../../src/tools/layer1/scaffoldGenre.js";
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

describe("scaffoldGenreImpl", () => {
  it("techno: builds master, a beat clock, and a hard feedback look", async () => {
    const bodies = captureCreateBodies();
    const result = await scaffoldGenreImpl(makeCtx(), {
      genre: "techno",
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();
    // Backbone: master output Null + beat clock.
    expect(bodies.find((b) => b.name === "master")?.type).toBe("nullTOP");
    expect(bodies.find((b) => b.name === "beat")?.type).toBe("beatCHOP");
    expect(bodies.find((b) => b.name === "tempo")?.type).toBe("nullCHOP");
    // Feedback look (reuses the createFeedbackNetwork structure).
    expect(bodies.some((b) => b.name === "feedback1" && b.type === "feedbackTOP")).toBe(true);
    expect(bodies.find((b) => b.name === "comp")?.parameters).toMatchObject({ operand: "maximum" });
    // Fast decay → strobe-y: a Level TOP with brightness1 (NOT a `gain` param).
    expect(bodies.find((b) => b.name === "gain")?.parameters).toMatchObject({ brightness1: 0.85 });
    // Genre look ends in a colorize glslTOP + textDAT frag.
    expect(bodies.some((b) => b.name === "colorize" && b.type === "glslTOP")).toBe(true);
    expect(bodies.some((b) => b.name === "colorize_frag" && b.type === "textDAT")).toBe(true);
    expect(textOf(result)).toContain("techno");
    expect(textOf(result)).toContain("master");
  });

  it("techno: pins the global tempo to the default 130 BPM and closes the feedback loop", async () => {
    captureCreateBodies();
    const scripts = captureExecScripts();
    await scaffoldGenreImpl(makeCtx(), { genre: "techno", parent_path: "/project1" });
    expect(scripts.some((s) => s.includes("op('/').time.tempo = 130"))).toBe(true);
    // feedbackTOP samples the gain node (loop closed via par.top).
    expect(scripts.some((s) => s.includes("feedback1") && s.includes(".par.top"))).toBe(true);
  });

  it("honors a bpm override (written to the global tempo, clamped)", async () => {
    captureCreateBodies();
    const scripts = captureExecScripts();
    await scaffoldGenreImpl(makeCtx(), { genre: "techno", bpm: 174, parent_path: "/project1" });
    expect(scripts.some((s) => s.includes("op('/').time.tempo = 174"))).toBe(true);
  });

  it("clamps an out-of-range bpm AND reports the clamped value in the note", async () => {
    captureCreateBodies();
    const scripts = captureExecScripts();
    const result = await scaffoldGenreImpl(makeCtx(), {
      genre: "techno",
      bpm: 300,
      parent_path: "/project1",
    });
    // The global tempo is clamped to the sane 40..220 ceiling.
    expect(scripts.some((s) => s.includes("op('/').time.tempo = 220"))).toBe(true);
    expect(scripts.some((s) => s.includes("time.tempo = 300"))).toBe(false);
    // The user-facing note shows the CLAMPED value (220), matching what was actually written —
    // not the raw, unclamped 300.
    const text = textOf(result);
    expect(text).toContain("220 BPM beat clock");
    expect(text).not.toContain("300 BPM");
    // The structured JSON also reports the CLAMPED value (not the raw 300).
    expect(text).toContain('"bpm": 220');
    expect(text).not.toContain('"bpm": 300');
  });

  it("ambient: builds a soft blurred-feedback look with slow decay at 70 BPM", async () => {
    const bodies = captureCreateBodies();
    const scripts = captureExecScripts();
    const result = await scaffoldGenreImpl(makeCtx(), {
      genre: "ambient",
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();
    expect(bodies.some((b) => b.name === "beat" && b.type === "beatCHOP")).toBe(true);
    // Soft look → an extra blurTOP and a high (slow-decay) brightness1.
    expect(bodies.some((b) => b.name === "blur" && b.type === "blurTOP")).toBe(true);
    expect(bodies.find((b) => b.name === "gain")?.parameters).toMatchObject({ brightness1: 0.97 });
    expect(scripts.some((s) => s.includes("op('/').time.tempo = 70"))).toBe(true);
    expect(textOf(result)).toContain("ambient");
  });

  it("installation: builds a generative noise look with NO beat clock by default", async () => {
    const bodies = captureCreateBodies();
    const scripts = captureExecScripts();
    const result = await scaffoldGenreImpl(makeCtx(), {
      genre: "installation",
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();
    expect(bodies.find((b) => b.name === "master")?.type).toBe("nullTOP");
    // No tempo: no beatCHOP, no nullCHOP, no global-tempo write.
    expect(bodies.some((b) => b.type === "beatCHOP")).toBe(false);
    expect(bodies.some((b) => b.type === "nullCHOP")).toBe(false);
    expect(scripts.some((s) => s.includes("time.tempo"))).toBe(false);
    // Generative noise look: a noiseTOP seed + a transformTOP drift, colorized.
    expect(bodies.some((b) => b.name === "seed" && b.type === "noiseTOP")).toBe(true);
    const drift = bodies.find((b) => b.name === "drift" && b.type === "transformTOP");
    expect(drift).toBeDefined();
    // The Transform TOP's translate params are tx/ty (NOT translate1/translate2). The node starts
    // with constant zeros; the drift comes from the time expressions set below.
    expect(drift?.parameters).toMatchObject({ tx: 0, ty: 0 });
    expect(drift?.parameters).not.toHaveProperty("translate1");
    expect(drift?.parameters).not.toHaveProperty("translate2");
    expect(textOf(result)).toContain("installation");
  });

  it("installation: drives the drift Transform TOP's tx/ty as time expressions (so it ACTUALLY drifts)", async () => {
    captureCreateBodies();
    const scripts = captureExecScripts();
    await scaffoldGenreImpl(makeCtx(), {
      genre: "installation",
      parent_path: "/project1",
    });
    // The bug: constant translate1/translate2 (a) were the wrong param names and (b) only offset the
    // field once — it never moved. The fix sets tx/ty to absTime.seconds-based EXPRESSIONS so the
    // noise field continuously drifts while the timeline plays.
    const driftScript = scripts.find(
      (s) => s.includes("absTime.seconds") && s.includes("EXPRESSION"),
    );
    expect(driftScript).toBeDefined();
    // Both translate axes are driven (different speeds → a diagonal creep).
    expect(driftScript).toContain("'tx', 0.02");
    expect(driftScript).toContain("'ty', 0.01");
    expect(driftScript).toContain("_p.mode = type(_p.mode).EXPRESSION");
    // The wrong param names never appear anywhere.
    expect(scripts.some((s) => s.includes("translate1") || s.includes("translate2"))).toBe(false);
  });

  it("installation: a bpm override adds a beat clock at that tempo", async () => {
    const bodies = captureCreateBodies();
    const scripts = captureExecScripts();
    await scaffoldGenreImpl(makeCtx(), {
      genre: "installation",
      bpm: 90,
      parent_path: "/project1",
    });
    expect(bodies.some((b) => b.name === "beat" && b.type === "beatCHOP")).toBe(true);
    expect(scripts.some((s) => s.includes("op('/').time.tempo = 90"))).toBe(true);
  });

  it("exposes a genre-appropriate live control bound to the look", async () => {
    captureCreateBodies();
    const techScripts = captureExecScripts();
    await scaffoldGenreImpl(makeCtx(), { genre: "techno", parent_path: "/project1" });
    const feedback = panelControls(techScripts).find((c) => c.name === "Feedback");
    expect(feedback?.bind_to?.[0]).toMatch(/gain\.brightness1$/);

    server.resetHandlers();
    captureCreateBodies();
    const instScripts = captureExecScripts();
    await scaffoldGenreImpl(makeCtx(), { genre: "installation", parent_path: "/project1" });
    const evolve = panelControls(instScripts).find((c) => c.name === "Evolve");
    expect(evolve?.bind_to?.[0]).toMatch(/seed\.period$/);
  });

  it("uses the genre as the default container name", async () => {
    const bodies = captureCreateBodies();
    await scaffoldGenreImpl(makeCtx(), { genre: "ambient", parent_path: "/project1" });
    // The container is the first baseCOMP created.
    expect(bodies.find((b) => b.type === "baseCOMP")?.name).toBe("ambient_show");
  });

  it("emits no inline preview image (structural scaffold)", async () => {
    captureCreateBodies();
    const result = await scaffoldGenreImpl(makeCtx(), {
      genre: "techno",
      parent_path: "/project1",
    });
    expect(result.content.some((c) => c.type === "image")).toBe(false);
  });

  it("returns a friendly isError result (never throws) when the bridge fails", async () => {
    server.use(
      http.post(`${TD_BASE}/api/nodes`, () =>
        HttpResponse.json({ ok: false, error: "boom" }, { status: 500 }),
      ),
    );
    const result = await scaffoldGenreImpl(makeCtx(), {
      genre: "techno",
      parent_path: "/project1",
    });
    expect(result.isError).toBe(true);
  });
});
