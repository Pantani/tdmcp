import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { createFeedbackNetworkImpl } from "../../src/tools/layer1/createFeedbackNetwork.js";
import { createVisualSystemImpl } from "../../src/tools/layer1/createVisualSystem.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

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

function captureCreateBodies(): Array<{ type: string; name?: string }> {
  const bodies: Array<{ type: string; name?: string }> = [];
  server.use(
    http.post(`${TD_BASE}/api/nodes`, async ({ request }) => {
      const body = (await request.json()) as { parent_path: string; type: string; name?: string };
      bodies.push({ type: body.type, name: body.name });
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

describe("feedback network colorize", () => {
  it("adds a colorize GLSL stage when colors are provided", async () => {
    const bodies = captureCreateBodies();
    await createFeedbackNetworkImpl(makeCtx(), {
      seed_type: "noise",
      transformations: ["blur"],
      feedback_gain: 0.9,
      colors: ["#1840d0", "#d020a0"],
      expose_controls: false,
      parent_path: "/project1",
    });
    expect(bodies.some((b) => b.type === "glslTOP" && b.name === "colorize")).toBe(true);
  });

  it("stays grayscale (no colorize stage) when no colors are provided", async () => {
    const bodies = captureCreateBodies();
    await createFeedbackNetworkImpl(makeCtx(), {
      seed_type: "noise",
      transformations: ["blur"],
      feedback_gain: 0.9,
      expose_controls: false,
      parent_path: "/project1",
    });
    expect(bodies.some((b) => b.name === "colorize")).toBe(false);
  });

  it("exposes a Feedback control bound to the gain's brightness1 when expose_controls is on", async () => {
    const scripts = captureExecScripts();
    await createFeedbackNetworkImpl(makeCtx(), {
      seed_type: "noise",
      transformations: ["blur"],
      feedback_gain: 0.9,
      expose_controls: true,
      parent_path: "/project1",
    });
    // The control panel runs as a single Python pass that appends a custom page.
    const panelScript = scripts.find((s) => s.includes("appendCustomPage"));
    expect(panelScript).toBeDefined();
    const b64 = /b64decode\("([^"]+)"\)/.exec(panelScript ?? "")?.[1];
    if (b64 === undefined) throw new Error("panel script did not embed a base64 payload");
    const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as {
      controls: Array<{ name: string; bind_to?: string[] }>;
    };
    const feedback = payload.controls.find((c) => c.name === "Feedback");
    expect(feedback).toBeDefined();
    expect(feedback?.bind_to?.[0]).toMatch(/\.brightness1$/);
  });

  it("skips the control panel when expose_controls is off", async () => {
    const scripts = captureExecScripts();
    await createFeedbackNetworkImpl(makeCtx(), {
      seed_type: "noise",
      transformations: ["blur"],
      feedback_gain: 0.9,
      expose_controls: false,
      parent_path: "/project1",
    });
    expect(scripts.some((s) => s.includes("appendCustomPage"))).toBe(false);
  });

  it("derives a palette from color words in a create_visual_system description", async () => {
    const scripts = captureExecScripts();
    await createVisualSystemImpl(makeCtx(), {
      description: "feedback trails in deep blues and magentas",
      parent_path: "/project1",
      resolution: "1080p",
      target_fps: 60,
    });
    const shader = scripts.find((s) => s.includes("colorize_frag"));
    expect(shader).toBeDefined();
    expect(shader).toContain("mix(");
  });
});
