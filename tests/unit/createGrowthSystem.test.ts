import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { z } from "zod";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  createGrowthSystemImpl,
  createGrowthSystemSchema,
} from "../../src/tools/layer1/createGrowthSystem.js";
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

/**
 * The rules-DAT JSON payload is written via a Python pass that contains
 *   op("...").text = "<json>"
 * Pull the JSON string out and parse it back.
 */
function findRulesPayload(scripts: string[]):
  | {
      rules: Array<{ from: string; to: string; weight?: number }>;
      axiom: string;
      generations: number;
      branchAngle: number;
      step_length: number;
      seed: number;
    }
  | undefined {
  const setter = scripts.find((s) => /op\("[^"]*\/rules"\)\.text = /.test(s));
  if (!setter) return undefined;
  const m = /op\("[^"]*\/rules"\)\.text = (".*?")\n?$/s.exec(setter);
  if (!m?.[1]) return undefined;
  const inner = JSON.parse(m[1]) as string;
  return JSON.parse(inner);
}

function run(args: Partial<z.input<typeof createGrowthSystemSchema>> = {}) {
  return createGrowthSystemImpl(makeCtx(), createGrowthSystemSchema.parse(args));
}

describe("create_growth_system", () => {
  it("builds the full network and ends at /out1", async () => {
    const bodies = captureCreateBodies();
    const result = await run();
    expect(result.isError).toBeFalsy();

    const types = new Set(bodies.map((b) => `${b.name}:${b.type}`));
    expect(types).toContain("rules:textDAT");
    expect(types).toContain("grow:scriptSOP");
    expect(types).toContain("grow_cb:textDAT");
    expect(types).toContain("thicken:tubeSOP");
    expect(types).toContain("center:transformSOP");
    expect(types).toContain("geo:geometryCOMP");
    expect(types).toContain("mat:constantMAT");
    expect(types).toContain("cam:cameraCOMP");
    expect(types).toContain("light:lightCOMP");
    expect(types).toContain("render:renderTOP");
    expect(types).toContain("out1:nullTOP");

    expect(textOf(result)).toContain("/project1/growth_system/out1");
  });

  it("writes the rules JSON with grammar + grow params", async () => {
    const scripts = captureExecScripts();
    await run({
      rules: [
        { from: "F", to: "FF" },
        { from: "F", to: "F+F", weight: 2 },
      ],
      generations: 3,
      axiom: "F",
      branchAngle: 30,
      step_length: 0.2,
      seed: 7,
    });
    const payload = findRulesPayload(scripts);
    expect(payload).toBeDefined();
    expect(payload?.axiom).toBe("F");
    expect(payload?.generations).toBe(3);
    expect(payload?.branchAngle).toBe(30);
    expect(payload?.step_length).toBe(0.2);
    expect(payload?.seed).toBe(7);
    expect(payload?.rules).toEqual([
      { from: "F", to: "FF" },
      { from: "F", to: "F+F", weight: 2 },
    ]);
  });

  it("docks the cook callback onto the Script SOP", async () => {
    const scripts = captureExecScripts();
    await run();
    expect(
      scripts.some(
        (s) =>
          s.includes("par.callbacks") &&
          s.includes("def cook(scriptOp)") &&
          s.includes("appendPoly"),
      ),
    ).toBe(true);
  });

  it("colours the constant MAT", async () => {
    const bodies = captureCreateBodies();
    await run({ color: [0.1, 0.2, 0.3] });
    expect(bodies.find((b) => b.name === "mat")?.parameters).toMatchObject({
      colorr: 0.1,
      colorg: 0.2,
      colorb: 0.3,
    });
  });

  it("exposes four live controls when expose_controls=true", async () => {
    const scripts = captureExecScripts();
    await run({ expose_controls: true });
    const names = panelControls(scripts).map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining(["Generations", "BranchAngle", "StepLength", "Thickness"]),
    );
  });

  it("exposes no controls when expose_controls=false", async () => {
    const scripts = captureExecScripts();
    await run({ expose_controls: false });
    expect(panelControls(scripts)).toEqual([]);
  });

  it("survives generations=0 with no throws", async () => {
    const result = await run({ generations: 0, expose_controls: false });
    expect(result.isError).toBeFalsy();
  });

  it("survives empty rules array", async () => {
    const result = await run({ rules: [], expose_controls: false });
    expect(result.isError).toBeFalsy();
  });

  it("returns a friendly isError result when the bridge create fails", async () => {
    server.use(
      http.post(`${TD_BASE}/api/nodes`, () =>
        HttpResponse.json({ ok: false, error: { code: "boom", message: "nope" } }, { status: 500 }),
      ),
    );
    const result = await run();
    expect(result.isError).toBe(true);
  });
});
