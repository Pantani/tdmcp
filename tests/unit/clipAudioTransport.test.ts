import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  clipAudioTransportImpl,
  clipAudioTransportSchema,
} from "../../src/tools/layer2/clipAudioTransport.js";
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
      return HttpResponse.json({
        ok: true,
        data: {
          result: null,
          stdout: JSON.stringify({ created: [], bound: [], warnings: [] }),
        },
      });
    }),
  );
  return scripts;
}

function panelControls(scripts: string[]): PanelControl[] {
  const panel = scripts.find((script) => script.includes("appendCustomPage"));
  const b64 = /b64decode\("([^"]+)"\)/.exec(panel ?? "")?.[1];
  if (!b64) return [];
  return (JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as { controls: PanelControl[] })
    .controls;
}

describe("clip_audio_transport", () => {
  it("creates movie and audio lanes with synchronized initial transport params", async () => {
    const bodies = captureCreateBodies();
    const result = await clipAudioTransportImpl(
      makeCtx(),
      clipAudioTransportSchema.parse({
        movie_file: "/clips/look.mov",
        audio_file: "/clips/look.wav",
        autoplay: false,
        loop: true,
        speed: 0.75,
      }),
    );
    expect(result.isError).toBeFalsy();

    const movie = bodies.find((body) => body.name === "movie_clip");
    expect(movie?.type).toBe("moviefileinTOP");
    expect(movie?.parameters).toMatchObject({
      file: "/clips/look.mov",
      play: 0,
      loop: 1,
      speed: 0.75,
    });

    const audio = bodies.find((body) => body.name === "audio_clip");
    expect(audio?.type).toBe("audiofileinCHOP");
    expect(audio?.parameters).toMatchObject({
      file: "/clips/look.wav",
      play: 0,
      loop: 1,
      speed: 0.75,
    });
    expect(bodies.some((body) => body.name === "video_out" && body.type === "nullTOP")).toBe(true);
    expect(bodies.some((body) => body.name === "audio_out" && body.type === "nullCHOP")).toBe(true);
    expect(textOf(result)).toContain("clip/audio transport");
  });

  it("exposes Play, Loop, and Speed controls bound across movie and audio lanes", async () => {
    const scripts = captureExecScripts();
    await clipAudioTransportImpl(
      makeCtx(),
      clipAudioTransportSchema.parse({ movie_file: "/clips/a.mov", audio_file: "/clips/a.wav" }),
    );

    const controls = panelControls(scripts);
    expect(controls.map((control) => control.name)).toEqual(["Play", "Loop", "Speed"]);
    expect(controls.find((control) => control.name === "Play")?.bind_to).toEqual([
      "/project1/clip_audio_transport/movie_clip.play",
      "/project1/clip_audio_transport/audio_clip.play",
    ]);
    expect(controls.find((control) => control.name === "Speed")?.bind_to).toEqual([
      "/project1/clip_audio_transport/movie_clip.speed",
      "/project1/clip_audio_transport/audio_clip.speed",
    ]);
  });

  it("can build a video-only transport and skip the control panel", async () => {
    const bodies = captureCreateBodies();
    const scripts = captureExecScripts();
    const result = await clipAudioTransportImpl(
      makeCtx(),
      clipAudioTransportSchema.parse({
        include_audio: false,
        expose_controls: false,
      }),
    );

    expect(result.isError).toBeFalsy();
    expect(bodies.some((body) => body.type === "audiofileinCHOP")).toBe(false);
    expect(scripts.some((script) => script.includes("appendCustomPage"))).toBe(false);
    expect(textOf(result)).toContain("movie/audio file paths");
  });

  it("rejects extreme speed values at the schema boundary", () => {
    expect(() => clipAudioTransportSchema.parse({ speed: 12 })).toThrow();
  });
});
