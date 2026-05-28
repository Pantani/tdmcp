import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { z } from "zod";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  createBodyReactiveImpl,
  createBodyReactiveSchema,
} from "../../src/tools/layer1/createBodyReactive.js";
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

function captureExecScripts(): string[] {
  const scripts: string[] = [];
  server.use(
    http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
      scripts.push(((await request.json()) as { script: string }).script);
      return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
    }),
  );
  return scripts;
}

function panelControls(
  scripts: string[],
): Array<{ name: string; type?: string; bind_to?: string[] }> {
  const panel = scripts.find((s) => s.includes("appendCustomPage"));
  const b64 = /b64decode\("([^"]+)"\)/.exec(panel ?? "")?.[1];
  if (b64 === undefined) return [];
  return (
    JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as {
      controls: Array<{ name: string; type?: string; bind_to?: string[] }>;
    }
  ).controls;
}

function run(args: Partial<z.input<typeof createBodyReactiveSchema>> = {}) {
  return createBodyReactiveImpl(makeCtx(), createBodyReactiveSchema.parse(args));
}

describe("create_body_reactive", () => {
  it("copies a dot onto every landmark point and captures a preview", async () => {
    const bodies = captureCreateBodies();
    const result = await run({ source: "synthetic", expose_controls: false });
    expect(result.isError).toBeFalsy();

    expect(bodies.find((b) => b.name === "geo")?.type).toBe("geometryCOMP");
    expect(bodies.find((b) => b.name === "dot")?.type).toBe("sphereSOP");
    // The pose CHOP → point cloud → Copy onto each point (instancing was unreliable; Copy works).
    const pts = bodies.find((b) => b.name === "pts");
    expect(pts?.type).toBe("choptoSOP");
    expect(String(pts?.parameters?.chop)).toMatch(/posein$/);
    expect(bodies.find((b) => b.name === "copy")?.type).toBe("copySOP");
    expect(bodies.find((b) => b.name === "dotmat")?.type).toBe("constantMAT");

    expect(result.content.some((c) => c.type === "image")).toBe(true);
    expect(textOf(result)).toContain("/project1/body_reactive/out1");
  });

  it("adds a bloom (Blur + add Composite) for visual_style='glow'", async () => {
    const bodies = captureCreateBodies();
    await run({
      source: "synthetic",
      visual_style: "glow",
      glow_amount: 24,
      expose_controls: false,
    });
    expect(bodies.find((b) => b.name === "bloom")?.parameters).toMatchObject({ size: 24 });
    expect(bodies.find((b) => b.name === "glow")?.parameters).toMatchObject({ operand: "add" });
  });

  it("builds a feedback loop for visual_style='trails'", async () => {
    const bodies = captureCreateBodies();
    await run({
      source: "synthetic",
      visual_style: "trails",
      trail_decay: 0.85,
      expose_controls: false,
    });
    expect(bodies.some((b) => b.type === "feedbackTOP")).toBe(true);
    expect(bodies.find((b) => b.name === "decay")?.parameters).toMatchObject({ opacity: 0.85 });
    expect(bodies.find((b) => b.name === "trails")?.parameters).toMatchObject({ operand: "over" });
  });

  it("renders straight to the Null with no post for visual_style='points'", async () => {
    const bodies = captureCreateBodies();
    await run({ source: "synthetic", visual_style: "points", expose_controls: false });
    expect(bodies.some((b) => b.type === "blurTOP")).toBe(false);
    expect(bodies.some((b) => b.type === "feedbackTOP")).toBe(false);
    expect(bodies.find((b) => b.name === "out1")?.type).toBe("nullTOP");
  });

  it("sizes and colours the dots and exposes the matching controls", async () => {
    const bodies = captureCreateBodies();
    const scripts = captureExecScripts();
    await run({ source: "synthetic", visual_style: "glow", color: "#00ff00", dot_size: 0.05 });
    expect(bodies.find((b) => b.name === "dot")?.parameters).toMatchObject({
      radx: 0.05,
      rady: 0.05,
      radz: 0.05,
    });
    // Green → constant MAT colorg ~1.
    expect(bodies.find((b) => b.name === "dotmat")?.parameters).toMatchObject({
      colorr: 0,
      colorg: 1,
      colorb: 0,
    });
    const controls = panelControls(scripts);
    expect(controls.map((c) => c.name)).toEqual(
      expect.arrayContaining(["DotSize", "Color", "Glow"]),
    );
    expect(controls.find((c) => c.name === "DotSize")?.bind_to).toEqual(
      expect.arrayContaining([expect.stringMatching(/dot\.radx$/)]),
    );
  });
});
