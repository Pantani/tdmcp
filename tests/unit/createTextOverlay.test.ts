import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { createTextOverlayImpl } from "../../src/tools/layer1/createTextOverlay.js";
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

describe("create_text_overlay", () => {
  it("builds a standalone transparent-background Text TOP → Null with an image preview", async () => {
    const result = await createTextOverlayImpl(makeCtx(), {
      text: "HELLO",
      font_size: 64,
      color: "#ffffff",
      align: "center",
      valign: "center",
      resolution: "1080p",
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("/project1/text_overlay/out1");
    expect(text).toContain("transparent background");
    // The Null output is a TOP, so finalize captures a preview image.
    expect(result.content.some((c) => c.type === "image")).toBe(true);
  });

  it("creates a Text TOP with transparent bg, font params, and the requested resolution", async () => {
    const bodies = captureCreateBodies();
    await createTextOverlayImpl(makeCtx(), {
      text: "TITLE",
      font_size: 96,
      color: "#ffffff",
      align: "left",
      valign: "top",
      resolution: "4K",
      parent_path: "/project1",
    });
    const txt = bodies.find((b) => b.name === "text");
    expect(txt?.type).toBe("textTOP");
    expect(txt?.parameters).toMatchObject({
      text: "TITLE",
      fontsizex: 96,
      fontsizey: 96,
      // Transparent background so only the glyphs composite over a source.
      bgalpha: 0,
      fontalpha: 1,
      alignx: "left",
      aligny: "top",
      outputresolution: "custom",
      resolutionw: 3840,
      resolutionh: 2160,
    });
    // Standalone: no Select/Composite, just Text → Null.
    expect(bodies.some((b) => b.type === "selectTOP")).toBe(false);
    expect(bodies.some((b) => b.type === "compositeTOP")).toBe(false);
    expect(bodies.some((b) => b.name === "out1" && b.type === "nullTOP")).toBe(true);
  });

  it("parses a non-white hex colour into 0..1 font RGB", async () => {
    const bodies = captureCreateBodies();
    await createTextOverlayImpl(makeCtx(), {
      text: "X",
      font_size: 64,
      color: "#ff3366",
      align: "center",
      valign: "center",
      resolution: "1080p",
      parent_path: "/project1",
    });
    const txt = bodies.find((b) => b.name === "text");
    expect(txt?.parameters?.fontcolorr).toBeCloseTo(1);
    expect(txt?.parameters?.fontcolorg).toBeCloseTo(0x33 / 255);
    expect(txt?.parameters?.fontcolorb).toBeCloseTo(0x66 / 255);
  });

  it("composites the text OVER a source via Select + Composite (text on top, source below)", async () => {
    const bodies = captureCreateBodies();
    const result = await createTextOverlayImpl(makeCtx(), {
      text: "LYRICS",
      font_size: 64,
      color: "#ffffff",
      align: "center",
      valign: "center",
      resolution: "1080p",
      source_path: "/scene/render",
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();
    // The source is pulled in by a Select TOP (works across COMP boundaries).
    const src = bodies.find((b) => b.type === "selectTOP");
    expect(src?.parameters).toMatchObject({ top: "/scene/render" });
    // Text composited 'over' the source.
    const comp = bodies.find((b) => b.type === "compositeTOP");
    expect(comp?.parameters).toMatchObject({ operand: "over" });
    expect(textOf(result)).toContain("composited over /scene/render");
  });
});
