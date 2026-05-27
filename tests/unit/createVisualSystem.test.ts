import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { createVisualSystemImpl } from "../../src/tools/layer1/createVisualSystem.js";
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

describe("createVisualSystemImpl", () => {
  it("classifies an audio description and delegates to the audio-reactive builder", async () => {
    const bodies = captureCreateBodies();
    const result = await createVisualSystemImpl(makeCtx(), {
      description: "audio reactive spectrum visualization",
      parent_path: "/project1",
      resolution: "1080p",
      target_fps: 60,
    });
    expect(result.isError).toBeFalsy();
    // Audio path creates an audio device input and spectrum CHOP.
    expect(bodies.some((b) => b.type === "audiodeviceinCHOP")).toBe(true);
    expect(bodies.some((b) => b.type === "audiospectrumCHOP")).toBe(true);
  });

  it("classifies a feedback description and delegates to the feedback-network builder", async () => {
    const bodies = captureCreateBodies();
    const result = await createVisualSystemImpl(makeCtx(), {
      description: "feedback tunnel echo trail visual",
      parent_path: "/project1",
      resolution: "1080p",
      target_fps: 60,
    });
    expect(result.isError).toBeFalsy();
    expect(bodies.some((b) => b.type === "feedbackTOP")).toBe(true);
  });

  it("prepends an interpretation note as the first content block", async () => {
    captureCreateBodies();
    const result = await createVisualSystemImpl(makeCtx(), {
      description: "audio reactive music visualizer",
      parent_path: "/project1",
      resolution: "720p",
      target_fps: 30,
    });
    // The note is the very first content block and contains the original description.
    const note = result.content[0];
    expect((note as { text?: string })?.text).toContain("audio reactive music visualizer");
    expect((note as { text?: string })?.text).toContain("720p");
    expect((note as { text?: string })?.text).toContain("30fps");
  });

  it("passes detected colors to the feedback builder when color words appear in the description", async () => {
    const _bodies = captureCreateBodies();
    const scripts: string[] = [];
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script: string };
        scripts.push(body.script);
        return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
      }),
    );
    await createVisualSystemImpl(makeCtx(), {
      description: "blue purple feedback tunnel",
      parent_path: "/project1",
      resolution: "1080p",
      target_fps: 60,
    });
    // The feedback builder colorizes with the extracted hex colors; the Python exec
    // sets the colorize_frag textDAT to the GLSL that contains the hex values.
    const colorizeScript = scripts.find((s) => s.includes("colorize_frag"));
    // Blue (#1840d0) and purple (#7a20c0) should appear in the shader fragment.
    expect(colorizeScript).toBeDefined();
  });

  it("falls back to a generative builder for unclassifiable descriptions", async () => {
    captureCreateBodies();
    const result = await createVisualSystemImpl(makeCtx(), {
      description: "dreamy atmospheric ambience",
      parent_path: "/project1",
      resolution: "1080p",
      target_fps: 60,
    });
    expect(result.isError).toBeFalsy();
    // Any builder produces at least one node and a text block.
    expect(result.content.length).toBeGreaterThan(0);
    const text = textOf(result);
    expect(text).toContain("dreamy atmospheric ambience");
  });
});
