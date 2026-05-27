import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { createVideoPlayerImpl } from "../../src/tools/layer1/createVideoPlayer.js";
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

describe("create_video_player", () => {
  it("builds an empty single-clip player (no file) → Null with a preview image", async () => {
    const bodies = captureCreateBodies();
    const result = await createVideoPlayerImpl(makeCtx(), {
      files: [],
      expose_controls: true,
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();

    const clip = bodies.find((b) => b.name === "clip1");
    expect(clip?.type).toBe("moviefileinTOP");
    expect(clip?.parameters).toMatchObject({ play: 1 });
    // No file yet — the player is left ready to point at one.
    expect(clip?.parameters).not.toHaveProperty("file");

    // Single clip → no Switch, output is a Null TOP (previewable).
    expect(bodies.some((b) => b.type === "switchTOP")).toBe(false);
    expect(bodies.some((b) => b.name === "out1" && b.type === "nullTOP")).toBe(true);
    expect(result.content.some((c) => c.type === "image")).toBe(true);

    const text = textOf(result);
    expect(text).toContain("1 clip(s)");
    expect(text).toContain("set the Movie File In's file");
  });

  it("loads a single named clip without a Switch", async () => {
    const bodies = captureCreateBodies();
    await createVideoPlayerImpl(makeCtx(), {
      files: ["/clips/a.mov"],
      expose_controls: false,
      parent_path: "/project1",
    });
    const clip = bodies.find((b) => b.name === "clip1");
    expect(clip?.parameters).toMatchObject({ file: "/clips/a.mov", play: 1 });
    expect(bodies.some((b) => b.type === "switchTOP")).toBe(false);
  });

  it("wires 2+ clips through a Switch TOP and exposes a Clip selector", async () => {
    const bodies = captureCreateBodies();
    const scripts = captureExecScripts();
    const result = await createVideoPlayerImpl(makeCtx(), {
      files: ["/clips/a.mov", "/clips/b.mov"],
      expose_controls: true,
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();

    expect(bodies.find((b) => b.name === "clip1")?.parameters).toMatchObject({
      file: "/clips/a.mov",
    });
    expect(bodies.find((b) => b.name === "clip2")?.parameters).toMatchObject({
      file: "/clips/b.mov",
    });
    const sw = bodies.find((b) => b.name === "switch");
    expect(sw?.type).toBe("switchTOP");
    expect(sw?.parameters).toMatchObject({ index: 0 });

    // The Clip selector spans the playlist and is bound to the Switch's index.
    const clipCtl = panelControls(scripts).find((c) => c.name === "Clip");
    expect(clipCtl?.type).toBe("int");
    expect(clipCtl?.bind_to?.[0]).toMatch(/switch\.index$/);

    expect(textOf(result)).toContain('"playlist": true');
  });

  it("binds Speed and Play across every clip", async () => {
    const scripts = captureExecScripts();
    await createVideoPlayerImpl(makeCtx(), {
      files: ["/clips/a.mov", "/clips/b.mov"],
      expose_controls: true,
      parent_path: "/project1",
    });
    const controls = panelControls(scripts);
    const speed = controls.find((c) => c.name === "Speed");
    expect(speed?.bind_to).toHaveLength(2);
    expect(speed?.bind_to?.every((b) => /clip\d\.speed$/.test(b))).toBe(true);
    const play = controls.find((c) => c.name === "Play");
    expect(play?.bind_to?.every((b) => /clip\d\.play$/.test(b))).toBe(true);
  });

  it("exposes no control panel when expose_controls is false", async () => {
    const scripts = captureExecScripts();
    await createVideoPlayerImpl(makeCtx(), {
      files: ["/clips/a.mov"],
      expose_controls: false,
      parent_path: "/project1",
    });
    expect(scripts.some((s) => s.includes("appendCustomPage"))).toBe(false);
  });
});
