import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { createDataVisualizationImpl } from "../../src/tools/layer1/createDataVisualization.js";
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

describe("createDataVisualizationImpl", () => {
  it("builds table → dattoCHOP → choptoTOP → scale → bars glslTOP → out1 for the default path", async () => {
    const bodies = captureCreateBodies();
    const result = await createDataVisualizationImpl(makeCtx(), {
      data_source: "table",
      chart_style: "bars",
      expose_controls: false,
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();
    expect(bodies.find((b) => b.name === "data")?.type).toBe("tableDAT");
    expect(bodies.some((b) => b.type === "dattoCHOP")).toBe(true);
    expect(bodies.some((b) => b.type === "choptoTOP")).toBe(true);
    expect(bodies.some((b) => b.name === "scale" && b.type === "levelTOP")).toBe(true);
    // Bars chart → fixed-resolution glslTOP.
    const chart = bodies.find((b) => b.name === "chart" && b.type === "glslTOP");
    expect(chart).toBeDefined();
    expect(chart?.parameters).toMatchObject({ resolutionw: 1280, resolutionh: 720 });
    expect(bodies.some((b) => b.name === "out1" && b.type === "nullTOP")).toBe(true);
    expect(result.content.some((c) => c.type === "image")).toBe(true);
  });

  it("uses a constantCHOP as the data source (no dattoCHOP) for the chop source type", async () => {
    const bodies = captureCreateBodies();
    await createDataVisualizationImpl(makeCtx(), {
      data_source: "chop",
      chart_style: "bars",
      expose_controls: false,
      parent_path: "/project1",
    });
    expect(bodies.find((b) => b.name === "data")?.type).toBe("constantCHOP");
    // chop source feeds directly into choptoTOP without a dattoCHOP bridge.
    expect(bodies.some((b) => b.type === "dattoCHOP")).toBe(false);
  });

  it("seeds the placeholder table with 16 rows via a Python exec", async () => {
    captureCreateBodies();
    const scripts = captureExecScripts();
    await createDataVisualizationImpl(makeCtx(), {
      data_source: "table",
      chart_style: "bars",
      expose_controls: false,
      parent_path: "/project1",
    });
    // Python fills the tableDAT with sine-wave sample values.
    expect(scripts.some((s) => s.includes("appendRow") && s.includes("clear"))).toBe(true);
  });

  it("exposes a Scale float control bound to the levelTOP brightness1 when expose_controls is true", async () => {
    captureCreateBodies();
    const scripts = captureExecScripts();
    await createDataVisualizationImpl(makeCtx(), {
      data_source: "table",
      chart_style: "bars",
      expose_controls: true,
      parent_path: "/project1",
    });
    const scale = panelControls(scripts).find((c) => c.name === "Scale");
    expect(scale).toBeDefined();
    expect(scale?.bind_to?.[0]).toMatch(/scale\.brightness1$/);
  });

  it("mentions data_source and chart_style in the summary", async () => {
    captureCreateBodies();
    const result = await createDataVisualizationImpl(makeCtx(), {
      data_source: "chop",
      chart_style: "bars",
      expose_controls: false,
      parent_path: "/project1",
    });
    const text = textOf(result);
    expect(text).toContain("chop");
    expect(text).toContain("bars");
  });
});
