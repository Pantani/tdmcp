import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { createPopLinesPointcloudImpl } from "../../src/tools/layer1/createPopLinesPointcloud.js";
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

// All schema-defaulted fields are supplied explicitly so the impl's inferred arg type
// is fully satisfied without relying on schema.parse.
const BASE_ARGS = {
  name: "pop_lines",
  parent_path: "/project1",
  auto_pattern: "noise" as const,
  count: 512,
  max_distance: 0.5,
  max_neighbors: 4,
  max_lines: 5000,
  color_mode: "flat" as const,
  color: [1, 1, 1] as [number, number, number],
  line_alpha: 0.7,
  spin: 10,
  point_size: 1.5,
  resolution: [1280, 720] as [number, number],
  expose_controls: false,
};

describe("create_pop_lines_pointcloud", () => {
  // Case 1 — auto-generate, noise pattern, defaults.
  it("auto noise: creates full node set including neighborPOP, scriptSOP and render rig", async () => {
    const bodies = captureCreateBodies();
    captureExecScripts();
    const result = await createPopLinesPointcloudImpl(makeCtx(), { ...BASE_ARGS });
    expect(result.isError).toBeFalsy();

    // Generator + noise
    expect(bodies.some((b) => b.name === "generator" && b.type === "pointgeneratorPOP")).toBe(true);
    expect(bodies.some((b) => b.type === "noisePOP")).toBe(true);
    // Spin transform POP
    expect(bodies.some((b) => b.name === "spin" && b.type === "transformPOP")).toBe(true);
    // Neighbor POP
    expect(bodies.some((b) => b.name === "nbr" && b.type === "neighborPOP")).toBe(true);
    // POP→SOP bridge
    expect(bodies.some((b) => b.name === "to_sop" && b.type === "poptoSOP")).toBe(true);
    // Script SOP + DAT
    expect(bodies.some((b) => b.name === "lines" && b.type === "scriptSOP")).toBe(true);
    expect(bodies.some((b) => b.name === "lines_script" && b.type === "textDAT")).toBe(true);
    // Material chain
    expect(bodies.some((b) => b.name === "line_mat" && b.type === "constantMAT")).toBe(true);
    expect(bodies.some((b) => b.name === "matsop" && b.type === "materialSOP")).toBe(true);
    expect(bodies.some((b) => b.name === "out_sop" && b.type === "nullSOP")).toBe(true);
    // Render rig
    expect(bodies.some((b) => b.type === "geometryCOMP")).toBe(true);
    expect(bodies.some((b) => b.type === "cameraCOMP")).toBe(true);
    expect(bodies.some((b) => b.type === "lightCOMP")).toBe(true);
    expect(bodies.some((b) => b.type === "renderTOP")).toBe(true);
    expect(bodies.some((b) => b.name === "out1" && b.type === "nullTOP")).toBe(true);

    // Output is the nullTOP path; source_mode = auto
    const text = result.content.find((c) => c.type === "text") as { text: string } | undefined;
    const json = /```json\n([\s\S]*?)\n```/.exec(text?.text ?? "")?.[1] ?? "{}";
    const data = JSON.parse(json) as { source_mode?: string; output_path?: string };
    expect(data.source_mode).toBe("auto");
    expect(data.output_path).toMatch(/out1$/);
  });

  // Case 2 — sphere auto_pattern: no noisePOP, uses spherePOP.
  it("sphere pattern: uses spherePOP generator and no noisePOP", async () => {
    const bodies = captureCreateBodies();
    captureExecScripts();
    await createPopLinesPointcloudImpl(makeCtx(), {
      ...BASE_ARGS,
      auto_pattern: "sphere",
    });
    expect(bodies.some((b) => b.name === "generator" && b.type === "spherePOP")).toBe(true);
    expect(bodies.some((b) => b.type === "noisePOP")).toBe(false);
    expect(bodies.some((b) => b.name === "nbr" && b.type === "neighborPOP")).toBe(true);
  });

  // Case 3 — sourced path: no generator/noise, source_mode=sourced.
  it("sourced path: skips generator/noise, sets spin POP input to source_path", async () => {
    const bodies = captureCreateBodies();
    const scripts = captureExecScripts();
    const result = await createPopLinesPointcloudImpl(makeCtx(), {
      ...BASE_ARGS,
      source_path: "/project1/some_pop",
    });
    expect(result.isError).toBeFalsy();
    // No auto generator or noise nodes.
    expect(bodies.some((b) => b.name === "generator")).toBe(false);
    expect(bodies.some((b) => b.type === "noisePOP")).toBe(false);
    // Spin POP is still created.
    expect(bodies.some((b) => b.name === "spin" && b.type === "transformPOP")).toBe(true);
    // Source path referenced in a bridge script (defensive par set or connect).
    expect(scripts.some((s) => s.includes("/project1/some_pop"))).toBe(true);

    const text = result.content.find((c) => c.type === "text") as { text: string } | undefined;
    const json = /```json\n([\s\S]*?)\n```/.exec(text?.text ?? "")?.[1] ?? "{}";
    const data = JSON.parse(json) as { source_mode?: string };
    expect(data.source_mode).toBe("sourced");
  });

  // Case 4 — neighbor POP params appear in bridge scripts.
  it("sends maxneighbors, maxdistance, dodist=1 through defensive par set scripts", async () => {
    captureCreateBodies();
    const scripts = captureExecScripts();
    await createPopLinesPointcloudImpl(makeCtx(), {
      ...BASE_ARGS,
      max_neighbors: 6,
      max_distance: 1.2,
    });
    const nbrScript = scripts.find((s) => s.includes("maxneighbors") && s.includes("6"));
    expect(nbrScript).toBeDefined();
    expect(nbrScript).toContain("maxdistance");
    expect(nbrScript).toContain("1.2");
    expect(nbrScript).toContain("dodist");
    // dodist value 1 appears in the param pairs
    expect(nbrScript).toContain("1");
  });

  // Case 5 — color_mode affects Script SOP body.
  it("by_distance mode: Script SOP DAT contains by_dist = True and by_isol = False", async () => {
    captureCreateBodies();
    const scripts = captureExecScripts();
    await createPopLinesPointcloudImpl(makeCtx(), {
      ...BASE_ARGS,
      color_mode: "by_distance",
    });
    // The DAT text assignment embeds the SOP body string.
    const datScript = scripts.find((s) => s.includes("by_dist = True"));
    expect(datScript).toBeDefined();
    expect(datScript).toContain("by_isol = False");
  });

  it("flat mode: Script SOP DAT contains by_dist = False and by_isol = False", async () => {
    captureCreateBodies();
    const scripts = captureExecScripts();
    await createPopLinesPointcloudImpl(makeCtx(), {
      ...BASE_ARGS,
      color_mode: "flat",
    });
    const datScript = scripts.find((s) => s.includes("by_dist = False"));
    expect(datScript).toBeDefined();
    expect(datScript).toContain("by_isol = False");
  });

  // Case 6 — controls include all five named knobs with non-empty bind_to.
  it("expose_controls=true: returns MaxDistance, MaxNeighbors, Spin, PointSize, LineAlpha", async () => {
    captureCreateBodies();
    const scripts = captureExecScripts();
    await createPopLinesPointcloudImpl(makeCtx(), {
      ...BASE_ARGS,
      expose_controls: true,
    });
    const controls = panelControls(scripts);
    const names = controls.map((c) => c.name);
    expect(names).toContain("MaxDistance");
    expect(names).toContain("MaxNeighbors");
    expect(names).toContain("Spin");
    expect(names).toContain("PointSize");
    expect(names).toContain("LineAlpha");

    for (const ctrl of controls) {
      expect(ctrl.bind_to?.length).toBeGreaterThan(0);
    }
  });
});
