import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { createMediaBinImpl, createMediaBinSchema } from "../../src/tools/layer1/createMediaBin.js";
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
  min?: number;
  max?: number;
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

/**
 * Captures every /api/exec script. When a script is the folder scan (`os.listdir`), reply with a
 * synthetic report (the named files) so the impl behaves as if TD found them; everything else (the
 * container placement, the engine/ramp python, layout, control panel) gets the default empty reply.
 */
function captureExecScripts(files: string[] = []): string[] {
  const scripts: string[] = [];
  server.use(
    http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
      const body = (await request.json()) as { script: string };
      scripts.push(body.script);
      if (body.script.includes("os.listdir")) {
        const report = JSON.stringify({
          files,
          found: files.length,
          scanned: files.length,
          warnings: [],
        });
        return HttpResponse.json({ ok: true, data: { result: null, stdout: report } });
      }
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

const FILES = ["/clips/a.mov", "/clips/b.mp4", "/clips/c.png"];

describe("create_media_bin", () => {
  it("scans the folder inside TD with the extension filter + max_clips cap", async () => {
    captureCreateBodies();
    const scripts = captureExecScripts(FILES);
    await createMediaBinImpl(makeCtx(), {
      name: "media_bin",
      parent_path: "/project1",
      folder: "/clips",
      extensions: ["mov", "mp4", "png", "jpg", "jpeg", "tif", "exr"],
      max_clips: 16,
      crossfade: 0.5,
      resolution: [1280, 720],
    });

    const scan = scripts.find((s) => s.includes("os.listdir"));
    expect(scan).toBeDefined();
    // The folder/extensions/cap travel as a base64 payload — decode and assert what we sent.
    const b64 = /b64decode\("([^"]+)"\)/.exec(scan ?? "")?.[1];
    expect(b64).toBeDefined();
    const payload = JSON.parse(Buffer.from(b64 as string, "base64").toString("utf8")) as {
      folder: string;
      extensions: string[];
      max_clips: number;
    };
    expect(payload.folder).toBe("/clips");
    expect(payload.extensions).toEqual(["mov", "mp4", "png", "jpg", "jpeg", "tif", "exr"]);
    expect(payload.max_clips).toBe(16);
    // The script filters by lower-cased extension and caps to max_clips.
    expect(scan).toContain("os.path.splitext");
    expect(scan).toContain("_matched[:_cap]");
  });

  it("builds one Movie File In per file, a Switch TOP, and a Null output", async () => {
    const bodies = captureCreateBodies();
    captureExecScripts(FILES);
    const result = await createMediaBinImpl(makeCtx(), {
      name: "media_bin",
      parent_path: "/project1",
      folder: "/clips",
      extensions: ["mov", "mp4", "png", "jpg", "jpeg", "tif", "exr"],
      max_clips: 16,
      crossfade: 0.5,
      resolution: [1280, 720],
    });
    expect(result.isError).toBeFalsy();

    expect(bodies.some((b) => b.type === "baseCOMP" && b.name === "media_bin")).toBe(true);
    const clips = bodies.filter((b) => b.type === "moviefileinTOP");
    expect(clips).toHaveLength(FILES.length);
    expect(clips[0]?.parameters?.file).toBe("/clips/a.mov");
    expect(clips[0]?.parameters?.play).toBe(1);
    const sw = bodies.find((b) => b.type === "switchTOP");
    expect(sw?.parameters?.index).toBe(0);
    // Uniform output resolution lives on the Switch (clips vary in native size).
    expect(sw?.parameters?.outputresolution).toBe("custom");
    expect(sw?.parameters?.resolutionw).toBe(1280);
    expect(sw?.parameters?.resolutionh).toBe(720);
    expect(bodies.some((b) => b.type === "nullTOP")).toBe(true);
  });

  it("deploys the Index→Switch ramp engine (Next/Prev wrap, fractional-index crossfade)", async () => {
    const bodies = captureCreateBodies();
    const scripts = captureExecScripts(FILES);
    await createMediaBinImpl(makeCtx(), {
      name: "media_bin",
      parent_path: "/project1",
      folder: "/clips",
      extensions: ["mov", "mp4", "png", "jpg", "jpeg", "tif", "exr"],
      max_clips: 16,
      crossfade: 0.5,
      resolution: [1280, 720],
    });
    // A Parameter Execute DAT (Index/Next/Prev) and an Execute DAT (per-frame ramp) are created.
    expect(bodies.some((b) => b.type === "parameterexecuteDAT" && b.name === "engine")).toBe(true);
    expect(bodies.some((b) => b.type === "executeDAT" && b.name === "ramp")).toBe(true);

    const engine = scripts.find((s) => s.includes("def onPulse"));
    expect(engine).toBeDefined();
    expect(engine).toContain("def onValueChange");
    // Next/Prev step the target index with wrap (% COUNT).
    expect(engine).toContain("% COUNT");
    const ramp = scripts.find((s) => s.includes("def onFrameStart"));
    expect(ramp).toBeDefined();
    // The ramp interpolates the Switch's float index toward the target (fractional blend).
    expect(ramp).toContain("sw.par.index");
  });

  it("exposes Index / Next / Prev / Crossfade controls (Crossfade seeded from the arg)", async () => {
    captureCreateBodies();
    const scripts = captureExecScripts(FILES);
    await createMediaBinImpl(makeCtx(), {
      name: "media_bin",
      parent_path: "/project1",
      folder: "/clips",
      extensions: ["mov", "mp4", "png", "jpg", "jpeg", "tif", "exr"],
      max_clips: 16,
      crossfade: 1.5,
      resolution: [1280, 720],
    });
    const controls = panelControls(scripts);
    const index = controls.find((c) => c.name === "Index");
    expect(index?.type).toBe("int");
    expect(index?.max).toBe(FILES.length - 1);
    expect(controls.find((c) => c.name === "Next")?.type).toBe("pulse");
    expect(controls.find((c) => c.name === "Prev")?.type).toBe("pulse");
    const xf = controls.find((c) => c.name === "Crossfade");
    expect(xf?.type).toBe("float");
    expect(xf?.default).toBe(1.5);
  });

  it("builds an empty, pointable bin (no engine) when the folder yields no files", async () => {
    const bodies = captureCreateBodies();
    captureExecScripts([]);
    const result = await createMediaBinImpl(makeCtx(), {
      name: "media_bin",
      parent_path: "/project1",
      folder: "/empty",
      extensions: ["mov", "mp4", "png", "jpg", "jpeg", "tif", "exr"],
      max_clips: 16,
      crossfade: 0.5,
      resolution: [1280, 720],
    });
    expect(result.isError).toBeFalsy();
    // One empty clip slot, no Switch/engine (nothing to switch between).
    expect(bodies.filter((b) => b.type === "moviefileinTOP")).toHaveLength(1);
    expect(bodies.some((b) => b.type === "switchTOP")).toBe(false);
    expect(bodies.some((b) => b.type === "parameterexecuteDAT")).toBe(false);
    const text = result.content.find((c) => c.type === "text") as { text: string } | undefined;
    expect(text?.text).toContain("empty media bin");
  });

  it("does not throw and is not an error when the bridge scan reports fatal", async () => {
    captureCreateBodies();
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script: string };
        if (body.script.includes("os.listdir")) {
          const report = JSON.stringify({
            files: [],
            found: 0,
            scanned: 0,
            warnings: [],
            fatal: "Folder not found: /nope",
          });
          return HttpResponse.json({ ok: true, data: { result: null, stdout: report } });
        }
        return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
      }),
    );
    // A failed scan is fail-forward: still build an empty bin, never throw, not an error result.
    const result = await createMediaBinImpl(makeCtx(), {
      name: "media_bin",
      parent_path: "/project1",
      folder: "/nope",
      extensions: ["mov"],
      max_clips: 16,
      crossfade: 0.5,
      resolution: [1280, 720],
    });
    expect(result.isError).toBeFalsy();
    const text = result.content.find((c) => c.type === "text") as { text: string } | undefined;
    expect(text?.text).toContain("Folder not found");
  });

  it("validates inputs at the schema boundary and applies sensible defaults", () => {
    // folder is required (no default).
    expect(() => createMediaBinSchema.parse({})).toThrow();
    expect(() => createMediaBinSchema.parse({ folder: "/clips", max_clips: 0 })).toThrow();
    expect(() => createMediaBinSchema.parse({ folder: "/clips", max_clips: 100 })).toThrow();
    expect(() => createMediaBinSchema.parse({ folder: "/clips", crossfade: -1 })).toThrow();
    const parsed = createMediaBinSchema.parse({ folder: "/clips" });
    expect(parsed.name).toBe("media_bin");
    expect(parsed.max_clips).toBe(16);
    expect(parsed.crossfade).toBe(0.5);
    expect(parsed.resolution).toEqual([1280, 720]);
    expect(parsed.extensions).toEqual(["mov", "mp4", "png", "jpg", "jpeg", "tif", "exr"]);
  });
});
