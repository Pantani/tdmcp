import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { createStrobeImpl } from "../../src/tools/layer1/createStrobe.js";
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

// Records every POST /api/nodes body so a test can assert what each node was created with.
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

// Records every POST /api/exec script so a test can assert which Python steps ran.
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

describe("create_strobe", () => {
  it("builds a bare flash strobe inside a container with a TOP output", async () => {
    const result = await createStrobeImpl(makeCtx(), {
      rate_hz: 8,
      intensity: 1,
      color: "#ffffff",
      duty: 0.5,
      expose_controls: false,
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("/project1/strobe");
    expect(text).toContain("/project1/strobe/out1");
    // The Null output is a TOP, so a preview image is captured into the result content.
    expect(result.content.some((c) => c.type === "image")).toBe(true);
  });

  it("creates the core nodes (constant flash, square LFO, level blink) with the right params", async () => {
    const bodies = captureCreateBodies();
    await createStrobeImpl(makeCtx(), {
      rate_hz: 12,
      intensity: 1,
      color: "#ffffff",
      duty: 0.5,
      expose_controls: false,
      parent_path: "/project1",
    });

    const flash = bodies.find((b) => b.name === "flash");
    expect(flash?.type).toBe("constantTOP");
    // White flash → all RGB channels at 1.
    expect(flash?.parameters).toMatchObject({ colorr: 1, colorg: 1, colorb: 1 });

    const lfo = bodies.find((b) => b.name === "strobe_lfo");
    expect(lfo?.type).toBe("lfoCHOP");
    // Hard on/off comes from a square wave at the requested rate; duty 0.5 → bias 0.
    expect(lfo?.parameters).toMatchObject({ wavetype: "square", frequency: 12, bias: 0 });

    const blink = bodies.find((b) => b.name === "blink");
    expect(blink?.type).toBe("levelTOP");
    // The Level TOP's brightness param is `brightness1` (NOT `gain`).
    expect(blink?.parameters).toHaveProperty("brightness1");

    // No input_path → no Select/Composite, output is the blink → null chain.
    expect(bodies.some((b) => b.type === "selectTOP")).toBe(false);
    expect(bodies.some((b) => b.type === "compositeTOP")).toBe(false);
    expect(bodies.some((b) => b.type === "nullTOP")).toBe(true);
  });

  it("maps duty to the LFO bias (0..1 → -1..1)", async () => {
    const bodies = captureCreateBodies();
    await createStrobeImpl(makeCtx(), {
      rate_hz: 8,
      intensity: 1,
      color: "#ffffff",
      duty: 0.75,
      expose_controls: false,
      parent_path: "/project1",
    });
    const lfo = bodies.find((b) => b.name === "strobe_lfo");
    // duty 0.75 → bias (0.75 - 0.5) * 2 = 0.5
    expect(lfo?.parameters?.bias).toBeCloseTo(0.5);
  });

  it("drives brightness1 by an EXPRESSION referencing the LFO channel by ABSOLUTE path", async () => {
    const scripts = captureExecScripts();
    await createStrobeImpl(makeCtx(), {
      rate_hz: 8,
      intensity: 0.8,
      color: "#ffffff",
      duty: 0.5,
      expose_controls: false,
      parent_path: "/project1",
    });
    // The brightness expression must reference the LFO channel by its absolute path
    // (param expressions evaluate relative to the node's parent) and switch to
    // EXPRESSION mode the same way animate_parameter does.
    const exprStep = scripts.find(
      (s) => s.includes("brightness1") && s.includes("EXPRESSION") && s.includes(".expr"),
    );
    expect(exprStep).toBeDefined();
    // The expression references the LFO by its ABSOLUTE path and reads its channel
    // (param expressions evaluate relative to the node's parent, so a relative ref breaks).
    expect(exprStep).toContain("/project1/strobe/strobe_lfo");
    expect(exprStep).toContain("['chan1']");
    // Crisp hard on/off: > 0 → intensity, else 0 (square swings [-1, 1]).
    expect(exprStep).toContain("0.8 if");
  });

  it("composites the flash OVER an input source via a Select TOP (absolute path)", async () => {
    const bodies = captureCreateBodies();
    const result = await createStrobeImpl(makeCtx(), {
      rate_hz: 8,
      intensity: 1,
      color: "#ffffff",
      duty: 0.5,
      input_path: "/scene/render",
      expose_controls: false,
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();

    // The source can live in another container, so it's pulled in by a Select TOP
    // (`top` = absolute path) rather than a cross-container wire.
    const select = bodies.find((b) => b.type === "selectTOP");
    expect(select?.parameters).toMatchObject({ top: "/scene/render" });

    // Composited with 'over' (alpha compositing) so the flash sits on top of the source.
    const comp = bodies.find((b) => b.type === "compositeTOP");
    expect(comp?.parameters).toMatchObject({ operand: "over" });

    const text = textOf(result);
    expect(text).toContain("flashing over /scene/render");
  });

  it("exposes Rate / Intensity / Duty controls bound to the right node parameters", async () => {
    const scripts = captureExecScripts();
    await createStrobeImpl(makeCtx(), {
      rate_hz: 8,
      intensity: 1,
      color: "#ffffff",
      duty: 0.5,
      expose_controls: true,
      parent_path: "/project1",
    });
    const panel = scripts.find((s) => s.includes("appendCustomPage"));
    expect(panel).toBeDefined();
    const b64 = /b64decode\("([^"]+)"\)/.exec(panel ?? "")?.[1];
    if (b64 === undefined) throw new Error("panel script did not embed a base64 payload");
    const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as {
      controls: Array<{ name: string; bind_to?: string[] }>;
    };
    const byName = (n: string) => payload.controls.find((c) => c.name === n);
    expect(byName("Rate")?.bind_to?.[0]).toMatch(/strobe_lfo\.frequency$/);
    expect(byName("Intensity")?.bind_to?.[0]).toMatch(/blink\.brightness1$/);
    expect(byName("Duty")?.bind_to?.[0]).toMatch(/strobe_lfo\.bias$/);
  });

  it("parses a non-white hex colour into 0..1 RGB on the constant TOP", async () => {
    const bodies = captureCreateBodies();
    await createStrobeImpl(makeCtx(), {
      rate_hz: 8,
      intensity: 1,
      color: "#ff0000",
      duty: 0.5,
      expose_controls: false,
      parent_path: "/project1",
    });
    const flash = bodies.find((b) => b.name === "flash");
    expect(flash?.parameters).toMatchObject({ colorr: 1, colorg: 0, colorb: 0 });
  });
});
