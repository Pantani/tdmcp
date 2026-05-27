import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { createKineticTextImpl } from "../../src/tools/layer1/createKineticText.js";
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

/** Records every POST /api/nodes body so a test can assert what the builder created. */
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

/** Records every POST /api/exec script so a test can assert which Python steps ran. */
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

describe("create_kinetic_text", () => {
  it("builds a flash system inside a container with a Text TOP carrying the text", async () => {
    const bodies = captureCreateBodies();
    const result = await createKineticTextImpl(makeCtx(), {
      text: "DUQUESA BANDIDA",
      mode: "flash",
      size: 120,
      color: "#ffffff",
      rate_hz: 2,
      expose_controls: false,
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("/project1/kinetic_text");
    expect(text).toContain("/project1/kinetic_text/out1");

    // A Text TOP rendering the requested string must be created.
    const textTop = bodies.find((b) => b.type === "textTOP");
    expect(textTop).toBeDefined();
    expect(textTop?.parameters?.text).toBe("DUQUESA BANDIDA");
    // flash gates brightness via a square LFO, so a Level TOP and a square-wave LFO exist.
    expect(bodies.some((b) => b.type === "levelTOP")).toBe(true);
    const lfo = bodies.find((b) => b.type === "lfoCHOP");
    expect(lfo?.parameters?.wavetype).toBe("square");
  });

  it("gates the Level TOP opacity (alpha) by an EXPRESSION referencing the LFO by absolute path", async () => {
    const scripts = captureExecScripts();
    await createKineticTextImpl(makeCtx(), {
      text: "FLASH",
      mode: "flash",
      size: 120,
      color: "#ffffff",
      rate_hz: 4,
      expose_controls: false,
      parent_path: "/project1",
    });
    // The flash expression must drive `opacity` (the alpha multiplier — NOT brightness1,
    // which only darkens RGB and would leave a black silhouette over a background),
    // reference the LFO channel by absolute path, and switch the param into EXPRESSION
    // mode. The path is JSON-stringified inside the expr, so its quotes are backslash-
    // escaped in the script text — match the path + channel separately to stay
    // quoting-agnostic.
    const expr = scripts.find(
      (s) => s.includes(".par.opacity") && s.includes("type(_p.mode).EXPRESSION"),
    );
    expect(expr).toBeDefined();
    expect(expr).toContain("/project1/kinetic_text/anim_lfo");
    expect(expr).toContain("['chan1']");
    // And it must NOT gate brightness1 (the old, buggy behaviour that flashed to black).
    expect(scripts.some((s) => s.includes("brightness1"))).toBe(false);
  });

  it("builds a pulse system that drives Transform sx/sy and a sine LFO", async () => {
    const bodies = captureCreateBodies();
    const scripts = captureExecScripts();
    const result = await createKineticTextImpl(makeCtx(), {
      text: "PULSE",
      mode: "pulse",
      size: 90,
      color: "#ff00aa",
      rate_hz: 1.5,
      expose_controls: false,
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("/project1/kinetic_text/out1");

    // pulse uses a sine LFO (smooth motion), a Transform TOP (scale) and a Level TOP (fade).
    const lfo = bodies.find((b) => b.type === "lfoCHOP");
    expect(lfo?.parameters?.wavetype).toBe("sine");
    expect(bodies.some((b) => b.type === "transformTOP")).toBe(true);
    expect(bodies.some((b) => b.type === "levelTOP")).toBe(true);
    // The scale is driven through sx/sy (NOT scalex/scaley).
    const scaleExpr = scripts.find(
      (s) => s.includes("'sx'") && s.includes("type(_p.mode).EXPRESSION"),
    );
    expect(scaleExpr).toBeDefined();
    expect(scaleExpr).toContain("'sy'");
  });

  it("builds a slide system that drives Transform tx", async () => {
    const bodies = captureCreateBodies();
    const scripts = captureExecScripts();
    const result = await createKineticTextImpl(makeCtx(), {
      text: "SLIDE",
      mode: "slide",
      size: 120,
      color: "#ffffff",
      rate_hz: 0.5,
      expose_controls: false,
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("/project1/kinetic_text/out1");

    expect(bodies.some((b) => b.type === "transformTOP")).toBe(true);
    // The horizontal scroll drives tx (NOT translatex) via expression mode, referencing
    // the LFO channel by absolute path (quotes backslash-escaped in the script text).
    const slideExpr = scripts.find(
      (s) => s.includes(".par.tx") && s.includes("type(_p.mode).EXPRESSION"),
    );
    expect(slideExpr).toBeDefined();
    expect(slideExpr).toContain("/project1/kinetic_text/anim_lfo");
    expect(slideExpr).toContain("['chan1']");
  });

  it("composites the text over an input via a Select TOP + Composite TOP when input_path is given", async () => {
    const bodies = captureCreateBodies();
    const result = await createKineticTextImpl(makeCtx(), {
      text: "OVER",
      mode: "flash",
      size: 120,
      color: "#ffffff",
      rate_hz: 2,
      input_path: "/scene/render",
      expose_controls: false,
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();
    // The cross-container source is pulled in by a Select TOP whose `top` points at the
    // source by absolute path (not a wire — wires can't cross containers), and composited
    // under the text with a Composite TOP (operand 'over').
    const select = bodies.find((b) => b.type === "selectTOP");
    expect(select?.parameters?.top).toBe("/scene/render");
    const comp = bodies.find((b) => b.type === "compositeTOP");
    expect(comp?.parameters?.operand).toBe("over");
  });

  it("exposes Text / Size / Color / Rate controls bound to the right parameters", async () => {
    const scripts = captureExecScripts();
    await createKineticTextImpl(makeCtx(), {
      text: "DUQUESA",
      mode: "flash",
      size: 120,
      color: "#ffffff",
      rate_hz: 2,
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
    const names = payload.controls.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(["Text", "Size", "Color", "Rate"]));
    expect(payload.controls.find((c) => c.name === "Text")?.bind_to?.[0]).toMatch(/\.text$/);
    expect(payload.controls.find((c) => c.name === "Rate")?.bind_to?.[0]).toMatch(
      /anim_lfo\.frequency$/,
    );
    expect(payload.controls.find((c) => c.name === "Size")?.bind_to).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/\.fontsizex$/),
        expect.stringMatching(/\.fontsizey$/),
      ]),
    );
  });
});
