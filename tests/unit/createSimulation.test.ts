import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { createSimulationImpl } from "../../src/tools/layer1/createSimulation.js";
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

describe("create_simulation", () => {
  it("reuses the validated reaction_diffusion recipe for the Gray-Scott type", async () => {
    const result = await createSimulationImpl(makeCtx(), {
      type: "reaction_diffusion",
      speed: 1,
      decay: 0.96,
      expose_controls: true,
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("Gray-Scott");
    // finalize records the recipe id it was built from.
    expect(text).toContain('"recipe": "reaction_diffusion"');
  });

  it("builds a feedback flow-field chain for slime, with a Decay knob on the level gain", async () => {
    const bodies = captureCreateBodies();
    const scripts = captureExecScripts();
    const result = await createSimulationImpl(makeCtx(), {
      type: "slime",
      speed: 1.5,
      decay: 0.9,
      expose_controls: true,
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();

    // Two noise fields: a static-ish seed and an animated flow field.
    expect(bodies.find((b) => b.name === "seed")?.parameters).toMatchObject({
      monochrome: 1,
      period: 2,
    });
    expect(bodies.some((b) => b.name === "flow" && b.type === "noiseTOP")).toBe(true);
    // The flow's Z drifts with time (× speed) so the field evolves.
    expect(
      scripts.some((s) => s.includes("absTime.seconds * 1.5") && s.includes("EXPRESSION")),
    ).toBe(true);

    // feedback → composite(maximum) → displace(by flow) → blur → level(decay).
    expect(bodies.some((b) => b.name === "feedback1" && b.type === "feedbackTOP")).toBe(true);
    expect(bodies.find((b) => b.name === "comp1")?.parameters).toMatchObject({
      operand: "maximum",
    });
    expect(bodies.some((b) => b.name === "displace" && b.type === "displaceTOP")).toBe(true);
    expect(bodies.find((b) => b.name === "blur")?.parameters).toMatchObject({ size: 1 });
    // Decay maps to the Level TOP brightness, and the loop closes via feedback.top = gain.
    expect(bodies.find((b) => b.name === "gain")?.parameters).toMatchObject({ brightness1: 0.9 });
    expect(scripts.some((s) => s.includes("feedback1") && s.includes(".par.top"))).toBe(true);

    const decay = panelControls(scripts).find((c) => c.name === "Decay");
    expect(decay?.default).toBe(0.9);
    expect(decay?.bind_to?.[0]).toMatch(/gain\.brightness1$/);
  });

  it("uses a wider seed period and blur for fluid", async () => {
    const bodies = captureCreateBodies();
    await createSimulationImpl(makeCtx(), {
      type: "fluid",
      speed: 1,
      decay: 0.96,
      expose_controls: false,
      parent_path: "/project1",
    });
    expect(bodies.find((b) => b.name === "seed")?.parameters).toMatchObject({ period: 6 });
    expect(bodies.find((b) => b.name === "blur")?.parameters).toMatchObject({ size: 3 });
  });
});
