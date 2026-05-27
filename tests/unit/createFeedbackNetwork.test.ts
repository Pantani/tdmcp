import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { createFeedbackNetworkImpl } from "../../src/tools/layer1/createFeedbackNetwork.js";
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

describe("createFeedbackNetworkImpl", () => {
  it("creates a noise seed, feedbackTOP, composite maximum, level gain, and out1", async () => {
    const bodies = captureCreateBodies();
    const scripts = captureExecScripts();
    const result = await createFeedbackNetworkImpl(makeCtx(), {
      seed_type: "noise",
      transformations: ["blur"],
      feedback_gain: 0.9,
      expose_controls: false,
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();
    // Noise seed with monochrome=1.
    expect(
      bodies.find((b) => b.name === "seed" && b.type === "noiseTOP")?.parameters,
    ).toMatchObject({ monochrome: 1 });
    // Core loop nodes.
    expect(bodies.some((b) => b.name === "feedback1" && b.type === "feedbackTOP")).toBe(true);
    // Gain node (levelTOP) — brightness1 set by PATCH after creation.
    expect(bodies.some((b) => b.name === "gain" && b.type === "levelTOP")).toBe(true);
    expect(bodies.some((b) => b.name === "out1" && b.type === "nullTOP")).toBe(true);
    // Loop-closing Python: feedbackTOP reads from gain.
    expect(scripts.some((s) => s.includes("feedback1") && s.includes(".par.top"))).toBe(true);
  });

  it("maps the shape seed_type to a circleTOP (not a noiseTOP)", async () => {
    const bodies = captureCreateBodies();
    await createFeedbackNetworkImpl(makeCtx(), {
      seed_type: "shape",
      transformations: [],
      feedback_gain: 0.95,
      expose_controls: false,
      parent_path: "/project1",
    });
    expect(bodies.find((b) => b.name === "seed")?.type).toBe("circleTOP");
  });

  it("creates each requested transformation node in the chain", async () => {
    const bodies = captureCreateBodies();
    await createFeedbackNetworkImpl(makeCtx(), {
      seed_type: "noise",
      transformations: ["blur", "displace", "level"],
      feedback_gain: 0.95,
      expose_controls: false,
      parent_path: "/project1",
    });
    expect(bodies.some((b) => b.name === "blur" && b.type === "blurTOP")).toBe(true);
    expect(bodies.some((b) => b.name === "displace" && b.type === "displaceTOP")).toBe(true);
    expect(bodies.some((b) => b.name === "level" && b.type === "levelTOP")).toBe(true);
  });

  it("adds a colorize glslTOP + textDAT frag when colors are provided", async () => {
    const bodies = captureCreateBodies();
    await createFeedbackNetworkImpl(makeCtx(), {
      seed_type: "noise",
      transformations: [],
      feedback_gain: 0.95,
      colors: ["#0a1a2e", "#8844ff"],
      expose_controls: false,
      parent_path: "/project1",
    });
    expect(bodies.some((b) => b.name === "colorize" && b.type === "glslTOP")).toBe(true);
    expect(bodies.some((b) => b.name === "colorize_frag" && b.type === "textDAT")).toBe(true);
  });

  it("exposes a Feedback float control bound to the gain levelTOP brightness1", async () => {
    captureCreateBodies();
    const scripts = captureExecScripts();
    await createFeedbackNetworkImpl(makeCtx(), {
      seed_type: "noise",
      transformations: [],
      feedback_gain: 0.8,
      expose_controls: true,
      parent_path: "/project1",
    });
    const feedback = panelControls(scripts).find((c) => c.name === "Feedback");
    expect(feedback).toBeDefined();
    expect(feedback?.default).toBe(0.8);
    expect(feedback?.bind_to?.[0]).toMatch(/gain\.brightness1$/);
  });

  it("includes seed type, gain, and transform count in the summary", async () => {
    captureCreateBodies();
    const result = await createFeedbackNetworkImpl(makeCtx(), {
      seed_type: "noise",
      transformations: ["blur", "displace"],
      feedback_gain: 0.95,
      expose_controls: false,
      parent_path: "/project1",
    });
    const text = textOf(result);
    expect(text).toContain("noise");
    expect(text).toContain("0.95");
    expect(text).toContain("2");
  });
});
