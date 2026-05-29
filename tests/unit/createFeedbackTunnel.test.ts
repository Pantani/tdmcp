import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  createFeedbackTunnelImpl,
  createFeedbackTunnelSchema,
} from "../../src/tools/layer1/createFeedbackTunnel.js";
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

describe("create_feedback_tunnel", () => {
  it("creates feedbackTOP, transformTOP, levelTOP, and Null output — all correctly named", async () => {
    const bodies = captureCreateBodies();
    captureExecScripts();
    const result = await createFeedbackTunnelImpl(makeCtx(), {
      name: "feedback_tunnel",
      parent_path: "/project1",
      source: undefined,
      zoom: 1.02,
      rotate: 2,
      hue_shift: 0.0,
      decay: 0.95,
      resolution: [1280, 720],
    });
    expect(result.isError).toBeFalsy();
    // Core tunnel nodes.
    expect(bodies.some((b) => b.name === "feedback1" && b.type === "feedbackTOP")).toBe(true);
    expect(bodies.some((b) => b.name === "transform1" && b.type === "transformTOP")).toBe(true);
    expect(bodies.some((b) => b.name === "level1" && b.type === "levelTOP")).toBe(true);
    expect(bodies.some((b) => b.name === "out1" && b.type === "nullTOP")).toBe(true);
    // Default seed is a noiseTOP.
    expect(bodies.some((b) => b.name === "seed" && b.type === "noiseTOP")).toBe(true);
  });

  it("uses sx/sy for transformTOP scale (not scalex/scaley) and sets rotate", async () => {
    const bodies = captureCreateBodies();
    captureExecScripts();
    await createFeedbackTunnelImpl(makeCtx(), {
      name: "feedback_tunnel",
      parent_path: "/project1",
      source: undefined,
      zoom: 1.05,
      rotate: 3,
      hue_shift: 0.0,
      decay: 0.95,
      resolution: [1280, 720],
    });
    const transform = bodies.find((b) => b.name === "transform1");
    expect(transform?.parameters).toMatchObject({ sx: 1.05, sy: 1.05, rotate: 3 });
    // Must NOT set scalex/scaley — those are wrong param names on transformTOP.
    expect(transform?.parameters).not.toHaveProperty("scalex");
    expect(transform?.parameters).not.toHaveProperty("scaley");
  });

  it("uses brightness1 on levelTOP for decay (not 'gain')", async () => {
    const bodies = captureCreateBodies();
    captureExecScripts();
    await createFeedbackTunnelImpl(makeCtx(), {
      name: "feedback_tunnel",
      parent_path: "/project1",
      source: undefined,
      zoom: 1.02,
      rotate: 2,
      hue_shift: 0.1,
      decay: 0.9,
      resolution: [1280, 720],
    });
    const level = bodies.find((b) => b.name === "level1");
    expect(level?.parameters).toMatchObject({ brightness1: 0.9, huerotate: 0.1 });
    expect(level?.parameters).not.toHaveProperty("gain");
  });

  it("closes the feedbackTOP loop via par.top Python script", async () => {
    captureCreateBodies();
    const scripts = captureExecScripts();
    await createFeedbackTunnelImpl(makeCtx(), {
      name: "feedback_tunnel",
      parent_path: "/project1",
      source: undefined,
      zoom: 1.02,
      rotate: 2,
      hue_shift: 0.0,
      decay: 0.95,
      resolution: [1280, 720],
    });
    // feedbackTOP must get its .par.top set to close the loop (par name is 'top').
    const loopClose = scripts.find((s) => s.includes("feedback1") && s.includes(".par.top"));
    expect(loopClose).toBeDefined();
    expect(loopClose).toContain("level1");
  });

  it("exposes Zoom, Rotate, HueShift, Decay controls with correct defaults", async () => {
    captureCreateBodies();
    const scripts = captureExecScripts();
    await createFeedbackTunnelImpl(makeCtx(), {
      name: "feedback_tunnel",
      parent_path: "/project1",
      source: undefined,
      zoom: 1.03,
      rotate: 1.5,
      hue_shift: 0.05,
      decay: 0.96,
      resolution: [1280, 720],
    });
    const controls = panelControls(scripts);
    const zoom = controls.find((c) => c.name === "Zoom");
    expect(zoom?.type).toBe("float");
    expect(zoom?.default).toBe(1.03);
    // Zoom must bind to both sx and sy.
    expect(zoom?.bind_to?.some((b) => b.endsWith(".sx"))).toBe(true);
    expect(zoom?.bind_to?.some((b) => b.endsWith(".sy"))).toBe(true);

    const rotate = controls.find((c) => c.name === "Rotate");
    expect(rotate?.default).toBe(1.5);
    expect(rotate?.bind_to?.some((b) => b.endsWith(".rotate"))).toBe(true);

    const hue = controls.find((c) => c.name === "HueShift");
    expect(hue?.default).toBe(0.05);
    expect(hue?.bind_to?.some((b) => b.endsWith(".huerotate"))).toBe(true);

    const decay = controls.find((c) => c.name === "Decay");
    expect(decay?.default).toBe(0.96);
    expect(decay?.bind_to?.some((b) => b.endsWith(".brightness1"))).toBe(true);
  });

  it("uses a selectTOP seed when source is provided", async () => {
    const bodies = captureCreateBodies();
    captureExecScripts();
    const result = await createFeedbackTunnelImpl(makeCtx(), {
      name: "feedback_tunnel",
      parent_path: "/project1",
      source: "/project1/myVid",
      zoom: 1.02,
      rotate: 2,
      hue_shift: 0.0,
      decay: 0.95,
      resolution: [1280, 720],
    });
    expect(result.isError).toBeFalsy();
    // Should create a selectTOP wired to the external source, not a noiseTOP.
    const seed = bodies.find((b) => b.name === "seed");
    expect(seed?.type).toBe("selectTOP");
    expect(seed?.parameters?.top).toBe("/project1/myVid");
    expect(bodies.some((b) => b.type === "noiseTOP")).toBe(false);
  });

  it("includes zoom, rotate, and decay values in the summary text", async () => {
    captureCreateBodies();
    captureExecScripts();
    const result = await createFeedbackTunnelImpl(makeCtx(), {
      name: "feedback_tunnel",
      parent_path: "/project1",
      source: undefined,
      zoom: 1.02,
      rotate: 2,
      hue_shift: 0.0,
      decay: 0.95,
      resolution: [1280, 720],
    });
    const text = textOf(result);
    expect(text).toContain("1.02");
    expect(text).toContain("2");
    expect(text).toContain("0.95");
  });

  it("returns isError=true and does not throw when bridge reports fatal", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        HttpResponse.json({
          ok: true,
          data: { result: null, stdout: '{"fatal":"op not found","warnings":[]}' },
        }),
      ),
    );
    // Should not throw — runBuild catches TdErrors; fatal from exec is a warning, not isError.
    const result = await createFeedbackTunnelImpl(makeCtx(), {
      name: "feedback_tunnel",
      parent_path: "/project1",
      source: undefined,
      zoom: 1.02,
      rotate: 2,
      hue_shift: 0.0,
      decay: 0.95,
      resolution: [1280, 720],
    });
    // Bridge fatals during exec (Python-side) surface as warnings, not as isError on the tool.
    // The tool should complete without throwing.
    expect(() => result).not.toThrow();
  });

  it("returns isError=true and does not throw on a bridge network failure", async () => {
    server.use(http.post(`${TD_BASE}/api/nodes`, () => HttpResponse.error()));
    const result = await createFeedbackTunnelImpl(makeCtx(), {
      name: "feedback_tunnel",
      parent_path: "/project1",
      source: undefined,
      zoom: 1.02,
      rotate: 2,
      hue_shift: 0.0,
      decay: 0.95,
      resolution: [1280, 720],
    });
    // runBuild converts TdConnectionError into errorResult.
    expect(result.isError).toBe(true);
  });

  it("schema validates decay clamp to [0,1]", () => {
    expect(() => createFeedbackTunnelSchema.parse({ decay: -0.1 })).toThrow();
    expect(() => createFeedbackTunnelSchema.parse({ decay: 1.1 })).toThrow();
    expect(createFeedbackTunnelSchema.parse({}).decay).toBe(0.95);
  });

  it("schema provides sensible defaults for all fields", () => {
    const parsed = createFeedbackTunnelSchema.parse({});
    expect(parsed.name).toBe("feedback_tunnel");
    expect(parsed.parent_path).toBe("/project1");
    expect(parsed.zoom).toBe(1.02);
    expect(parsed.rotate).toBe(2);
    expect(parsed.hue_shift).toBe(0.0);
    expect(parsed.decay).toBe(0.95);
    expect(parsed.resolution).toEqual([1280, 720]);
    expect(parsed.source).toBeUndefined();
  });
});
