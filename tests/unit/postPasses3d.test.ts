import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { postPasses3dImpl } from "../../src/tools/layer2/postPasses3d.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

interface CreatedNodeBody {
  parent_path: string;
  type: string;
  name?: string;
}

interface ConnectBody {
  source_path: string;
  target_path: string;
  source_output: number;
  target_input: number;
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

interface Captured {
  creates: CreatedNodeBody[];
  connects: ConnectBody[];
  execs: string[];
}

function capture(): Captured {
  const creates: CreatedNodeBody[] = [];
  const connects: ConnectBody[] = [];
  const execs: string[] = [];
  server.use(
    http.post(`${TD_BASE}/api/nodes`, async ({ request }) => {
      const body = (await request.json()) as CreatedNodeBody;
      creates.push(body);
      const name = body.name ?? `${body.type.replace(/[^a-zA-Z0-9]/g, "").toLowerCase()}1`;
      return HttpResponse.json({
        ok: true,
        data: { path: `${body.parent_path}/${name}`, type: body.type, name },
      });
    }),
    // connect endpoint — succeed so connectNodes resolves cleanly.
    http.post(`${TD_BASE}/api/connect`, async ({ request }) => {
      const body = (await request.json()) as ConnectBody;
      connects.push(body);
      return HttpResponse.json({
        ok: true,
        data: {
          source_path: body.source_path,
          target_path: body.target_path,
          connected: true,
        },
      });
    }),
    http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
      const body = (await request.json()) as { script: string };
      execs.push(body.script);
      return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
    }),
  );
  return { creates, connects, execs };
}

function getResultData<T = unknown>(result: {
  content: Array<{ type: string; text?: string }>;
}): T {
  const text = result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  const match = text.match(/```json\n([\s\S]+?)\n```/);
  if (!match?.[1]) throw new Error(`no json fence in: ${text}`);
  return JSON.parse(match[1]) as T;
}

interface ResultShape {
  container_path: string;
  output_path: string;
  color_top: string;
  depth_top: string;
  normal_top: string;
  velocity_top: string;
  auto_depth_top?: string;
  passes: Array<{ name: string; path: string }>;
  warnings: string[];
}

describe("postPasses3dImpl", () => {
  it("default args + all four passes enabled builds the full chain", async () => {
    const cap = capture();
    const result = await postPasses3dImpl(makeCtx(), {
      parent_path: "/project1",
      name: "post_passes_3d",
      color_top: "/project1/render1",
      depth_top: "/project1/depth1",
      normal_top: "/project1/normal1",
      velocity_top: "/project1/velocity1",
      ssao_enable: true,
      ssao_radius: 0.05,
      ssao_intensity: 1.0,
      ssr_enable: true,
      ssr_intensity: 0.5,
      dof_enable: true,
      dof_focus: 0.3,
      dof_aperture: 0.02,
      motion_blur_enable: true,
      motion_blur_amount: 0.3,
      resolution: [1280, 720],
    });
    expect(result.isError).toBeFalsy();
    const data = getResultData<ResultShape>(result);

    // baseCOMP created.
    expect(
      cap.creates.find((b) => b.type === "baseCOMP" && b.name === "post_passes_3d"),
    ).toBeTruthy();

    // four selectTOPs for the AOVs.
    const selects = cap.creates.filter((b) => b.type === "selectTOP");
    expect(selects.map((s) => s.name).sort()).toEqual(
      ["sel_color", "sel_depth", "sel_normal", "sel_velocity"].sort(),
    );

    // four glslTOPs with companion textDATs.
    const glsl = cap.creates.filter((b) => b.type === "glslTOP").map((b) => b.name);
    expect(glsl.sort()).toEqual(["glsl_dof", "glsl_mb", "glsl_ssao", "glsl_ssr"]);
    const dats = cap.creates.filter((b) => b.type === "textDAT").map((b) => b.name);
    expect(dats.sort()).toEqual([
      "glsl_dof_frag",
      "glsl_mb_frag",
      "glsl_ssao_frag",
      "glsl_ssr_frag",
    ]);

    // null output at end.
    expect(cap.creates.find((b) => b.type === "nullTOP" && b.name === "out1")).toBeTruthy();

    // returned passes in fixed order.
    expect(data.passes.map((p) => p.name)).toEqual([
      "glsl_ssao",
      "glsl_ssr",
      "glsl_dof",
      "glsl_mb",
    ]);
    expect(data.output_path).toMatch(/\/out1$/);
    expect(data.container_path).toBe("/project1/post_passes_3d");

    // chain wiring: each pass receives prev color on input 0.
    const inputZeroTargets = cap.connects
      .filter((c) => c.target_input === 0)
      .map((c) => c.target_path);
    // sel_color → glsl_ssao, glsl_ssao → glsl_ssr, … → out1
    expect(inputZeroTargets).toContain("/project1/post_passes_3d/glsl_ssao");
    expect(inputZeroTargets).toContain("/project1/post_passes_3d/glsl_ssr");
    expect(inputZeroTargets).toContain("/project1/post_passes_3d/glsl_dof");
    expect(inputZeroTargets).toContain("/project1/post_passes_3d/glsl_mb");
    expect(inputZeroTargets).toContain("/project1/post_passes_3d/out1");
  });

  it("all passes disabled — only sel_color is created and out1 is wired from it", async () => {
    const cap = capture();
    const result = await postPasses3dImpl(makeCtx(), {
      parent_path: "/project1",
      name: "post_passes_3d",
      color_top: "/project1/null1",
      depth_top: "",
      normal_top: "",
      velocity_top: "",
      ssao_enable: false,
      ssao_radius: 0.05,
      ssao_intensity: 1.0,
      ssr_enable: false,
      ssr_intensity: 0.5,
      dof_enable: false,
      dof_focus: 0.3,
      dof_aperture: 0.02,
      motion_blur_enable: false,
      motion_blur_amount: 0.3,
      resolution: [1280, 720],
    });
    expect(result.isError).toBeFalsy();
    const data = getResultData<ResultShape>(result);

    const selectNames = cap.creates.filter((b) => b.type === "selectTOP").map((b) => b.name);
    expect(selectNames).toEqual(["sel_color"]);
    expect(cap.creates.find((b) => b.type === "glslTOP")).toBeUndefined();
    expect(data.passes).toEqual([]);
    expect(data.warnings.some((w) => w.includes("All passes disabled"))).toBe(true);
    // out1 wired from sel_color
    const out1Connect = cap.connects.find((c) => c.target_path.endsWith("/out1"));
    expect(out1Connect?.source_path).toBe("/project1/post_passes_3d/sel_color");
  });

  it("SSR enabled but normal_top empty → SSR skipped with warning", async () => {
    const cap = capture();
    const result = await postPasses3dImpl(makeCtx(), {
      parent_path: "/project1",
      name: "post_passes_3d",
      color_top: "/project1/null1",
      depth_top: "/project1/depth1",
      normal_top: "",
      velocity_top: "",
      ssao_enable: false,
      ssao_radius: 0.05,
      ssao_intensity: 1.0,
      ssr_enable: true,
      ssr_intensity: 0.5,
      dof_enable: false,
      dof_focus: 0.3,
      dof_aperture: 0.02,
      motion_blur_enable: false,
      motion_blur_amount: 0.3,
      resolution: [1280, 720],
    });
    const data = getResultData<ResultShape>(result);
    expect(cap.creates.find((b) => b.type === "glslTOP" && b.name === "glsl_ssr")).toBeUndefined();
    expect(data.warnings.some((w) => w.includes("SSR requires normal_top"))).toBe(true);
    expect(data.passes).toEqual([]);
  });

  it("depth_top empty + color ends in /render1 auto-creates a depthTOP and sets .par.rendertop", async () => {
    const cap = capture();
    const result = await postPasses3dImpl(makeCtx(), {
      parent_path: "/project1",
      name: "post_passes_3d",
      color_top: "/project1/render1",
      depth_top: "",
      normal_top: "",
      velocity_top: "",
      ssao_enable: true,
      ssao_radius: 0.05,
      ssao_intensity: 1.0,
      ssr_enable: false,
      ssr_intensity: 0.5,
      dof_enable: false,
      dof_focus: 0.3,
      dof_aperture: 0.02,
      motion_blur_enable: false,
      motion_blur_amount: 0.3,
      resolution: [1280, 720],
    });
    expect(result.isError).toBeFalsy();
    const data = getResultData<ResultShape>(result);
    // depthTOP created in the PARENT (sibling of render1).
    const depthAuto = cap.creates.find((b) => b.type === "depthTOP");
    expect(depthAuto).toBeDefined();
    expect(depthAuto?.parent_path).toBe("/project1");
    expect(data.auto_depth_top).toBeDefined();
    // .par.rendertop was attempted via executePythonScript.
    expect(cap.execs.some((s) => s.includes(".par.rendertop"))).toBe(true);
  });

  it("writes shader text with required sentinels and no uTime", async () => {
    const cap = capture();
    await postPasses3dImpl(makeCtx(), {
      parent_path: "/project1",
      name: "post_passes_3d",
      color_top: "/project1/render1",
      depth_top: "/project1/depth1",
      normal_top: "/project1/normal1",
      velocity_top: "/project1/velocity1",
      ssao_enable: true,
      ssao_radius: 0.05,
      ssao_intensity: 1.0,
      ssr_enable: true,
      ssr_intensity: 0.5,
      dof_enable: true,
      dof_focus: 0.3,
      dof_aperture: 0.02,
      motion_blur_enable: true,
      motion_blur_amount: 0.3,
      resolution: [1280, 720],
    });
    const shaderScripts = cap.execs.filter((s) => s.includes(".text ="));
    expect(shaderScripts.length).toBe(4);
    for (const s of shaderScripts) {
      expect(s).toContain("out vec4 fragColor;");
      expect(s).toContain("TDOutputSwizzle");
      expect(s).not.toContain("uTime");
    }
  });

  it("required color→pass wire failure returns isError (connect endpoint absent, batch+python both fail)", async () => {
    const creates: CreatedNodeBody[] = [];
    server.use(
      http.post(`${TD_BASE}/api/nodes`, async ({ request }) => {
        const body = (await request.json()) as CreatedNodeBody;
        creates.push(body);
        const name = body.name ?? `${body.type.replace(/[^a-zA-Z0-9]/g, "").toLowerCase()}1`;
        return HttpResponse.json({
          ok: true,
          data: { path: `${body.parent_path}/${name}`, type: body.type, name },
        });
      }),
      // /api/connect returns 404 — simulates older bridge without the endpoint.
      http.post(`${TD_BASE}/api/connect`, () => HttpResponse.json({ ok: false }, { status: 404 })),
      // /api/batch connect op fails inside.
      http.post(`${TD_BASE}/api/batch`, () =>
        HttpResponse.json({ ok: true, data: { results: [{ ok: false, error: "no such op" }] } }),
      ),
      // /api/exec also fails — Python fallback rejects too.
      http.post(`${TD_BASE}/api/exec`, () =>
        HttpResponse.json({ ok: false, error: "exec failed" }, { status: 500 }),
      ),
    );
    const result = await postPasses3dImpl(makeCtx(), {
      parent_path: "/project1",
      name: "post_passes_3d",
      color_top: "/project1/render1",
      depth_top: "/project1/depth1",
      normal_top: "",
      velocity_top: "",
      ssao_enable: true,
      ssao_radius: 0.05,
      ssao_intensity: 1.0,
      ssr_enable: false,
      ssr_intensity: 0.5,
      dof_enable: false,
      dof_focus: 0.3,
      dof_aperture: 0.02,
      motion_blur_enable: false,
      motion_blur_amount: 0.3,
      resolution: [1280, 720],
    });
    expect(result.isError).toBe(true);
  });

  it("SSAO/DOF skipped with warning when depth_top absent and color_top is not a render TOP", async () => {
    const cap = capture();
    const result = await postPasses3dImpl(makeCtx(), {
      parent_path: "/project1",
      name: "post_passes_3d",
      color_top: "/project1/null1", // not a renderTOP path
      depth_top: "",
      normal_top: "",
      velocity_top: "",
      ssao_enable: true,
      ssao_radius: 0.05,
      ssao_intensity: 1.0,
      ssr_enable: false,
      ssr_intensity: 0.5,
      dof_enable: true,
      dof_focus: 0.3,
      dof_aperture: 0.02,
      motion_blur_enable: false,
      motion_blur_amount: 0.3,
      resolution: [1280, 720],
    });
    expect(result.isError).toBeFalsy();
    const data = getResultData<ResultShape>(result);

    // Neither glsl_ssao nor glsl_dof should be created.
    expect(cap.creates.find((b) => b.type === "glslTOP" && b.name === "glsl_ssao")).toBeUndefined();
    expect(cap.creates.find((b) => b.type === "glslTOP" && b.name === "glsl_dof")).toBeUndefined();

    // Passes array must be empty.
    expect(data.passes).toEqual([]);

    // Warnings must describe the skip.
    expect(data.warnings.some((w) => w.includes("SSAO skipped"))).toBe(true);
    expect(data.warnings.some((w) => w.includes("DOF skipped"))).toBe(true);

    // sel_depth must NOT be created (no depth source).
    expect(
      cap.creates.find((b) => b.type === "selectTOP" && b.name === "sel_depth"),
    ).toBeUndefined();
  });

  it("SSR skipped with warning when depth_top absent and color_top is not a render TOP", async () => {
    const cap = capture();
    const result = await postPasses3dImpl(makeCtx(), {
      parent_path: "/project1",
      name: "post_passes_3d",
      color_top: "/project1/null1",
      depth_top: "",
      normal_top: "/project1/normal1",
      velocity_top: "",
      ssao_enable: false,
      ssao_radius: 0.05,
      ssao_intensity: 1.0,
      ssr_enable: true,
      ssr_intensity: 0.5,
      dof_enable: false,
      dof_focus: 0.3,
      dof_aperture: 0.02,
      motion_blur_enable: false,
      motion_blur_amount: 0.3,
      resolution: [1280, 720],
    });
    expect(result.isError).toBeFalsy();
    const data = getResultData<ResultShape>(result);

    expect(cap.creates.find((b) => b.type === "glslTOP" && b.name === "glsl_ssr")).toBeUndefined();
    expect(data.passes).toEqual([]);
    expect(data.warnings.some((w) => w.includes("SSR skipped") && w.includes("depth TOP"))).toBe(
      true,
    );
  });

  it("returned JSON exposes the expected fields", async () => {
    const result = await postPasses3dImpl(makeCtx(), {
      parent_path: "/project1",
      name: "post_passes_3d",
      color_top: "/project1/render1",
      depth_top: "/project1/depth1",
      normal_top: "/project1/normal1",
      velocity_top: "",
      ssao_enable: true,
      ssao_radius: 0.05,
      ssao_intensity: 1.0,
      ssr_enable: false,
      ssr_intensity: 0.5,
      dof_enable: false,
      dof_focus: 0.3,
      dof_aperture: 0.02,
      motion_blur_enable: false,
      motion_blur_amount: 0.3,
      resolution: [1280, 720],
    });
    const data = getResultData<ResultShape>(result);
    const keys = Object.keys(data).sort();
    for (const k of [
      "color_top",
      "container_path",
      "depth_top",
      "normal_top",
      "output_path",
      "passes",
      "velocity_top",
      "warnings",
    ]) {
      expect(keys).toContain(k);
    }
  });
});
