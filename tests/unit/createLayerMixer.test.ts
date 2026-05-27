import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { createLayerMixerImpl } from "../../src/tools/layer1/createLayerMixer.js";
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

describe("create_layer_mixer", () => {
  it("drops in two demo sources and a Cross TOP when given fewer than two inputs", async () => {
    const bodies = captureCreateBodies();
    const result = await createLayerMixerImpl(makeCtx(), {
      inputs: [],
      blend: "crossfade",
      expose_controls: true,
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();
    // Distinct demo sources so the mix is visibly doing something.
    expect(bodies.find((b) => b.name === "srcA")?.type).toBe("noiseTOP");
    expect(bodies.find((b) => b.name === "srcB")?.type).toBe("rampTOP");
    // Crossfade → an A/B Cross TOP at the midpoint.
    const cross = bodies.find((b) => b.name === "mix");
    expect(cross?.type).toBe("crossTOP");
    expect(cross?.parameters).toMatchObject({ cross: 0.5 });
    expect(bodies.some((b) => b.name === "out1" && b.type === "nullTOP")).toBe(true);
    // Output is a TOP, so a preview is captured.
    expect(result.content.some((c) => c.type === "image")).toBe(true);
    expect(textOf(result)).toContain("layer mixer (crossfade)");
  });

  it("pulls two real inputs through Select TOPs into the Cross, with a Crossfade knob", async () => {
    const bodies = captureCreateBodies();
    const scripts = captureExecScripts();
    await createLayerMixerImpl(makeCtx(), {
      inputs: ["/project1/deckA", "/project1/deckB"],
      blend: "crossfade",
      expose_controls: true,
      parent_path: "/project1",
    });
    const selects = bodies.filter((b) => b.type === "selectTOP");
    expect(selects).toHaveLength(2);
    expect(selects.map((s) => s.parameters?.top)).toEqual(["/project1/deckA", "/project1/deckB"]);
    expect(bodies.some((b) => b.name === "mix" && b.type === "crossTOP")).toBe(true);
    // No demo sources when real inputs are supplied.
    expect(bodies.some((b) => b.name === "srcA")).toBe(false);

    const crossfade = panelControls(scripts).find((c) => c.name === "Crossfade");
    expect(crossfade?.bind_to?.[0]).toMatch(/mix\.cross$/);
  });

  it("composites with the chosen blend mode (no Cross, no Crossfade) for non-crossfade blends", async () => {
    const bodies = captureCreateBodies();
    const scripts = captureExecScripts();
    await createLayerMixerImpl(makeCtx(), {
      inputs: ["/a", "/b"],
      blend: "add",
      expose_controls: true,
      parent_path: "/project1",
    });
    const mix = bodies.find((b) => b.name === "mix");
    expect(mix?.type).toBe("compositeTOP");
    expect(mix?.parameters).toMatchObject({ operand: "add" });
    expect(bodies.some((b) => b.type === "crossTOP")).toBe(false);
    expect(panelControls(scripts).some((c) => c.name === "Crossfade")).toBe(false);
  });

  it("falls back to an additive composite when crossfade is asked for with != 2 sources", async () => {
    const bodies = captureCreateBodies();
    await createLayerMixerImpl(makeCtx(), {
      inputs: ["/a", "/b", "/c"],
      blend: "crossfade",
      expose_controls: true,
      parent_path: "/project1",
    });
    // 3 sources can't go through an A/B Cross, so it composites them with 'add'.
    const mix = bodies.find((b) => b.name === "mix");
    expect(mix?.type).toBe("compositeTOP");
    expect(mix?.parameters).toMatchObject({ operand: "add" });
  });
});
