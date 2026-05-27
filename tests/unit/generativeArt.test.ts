import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { createGenerativeArtImpl } from "../../src/tools/layer1/createGenerativeArt.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

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

const SHADER = "out vec4 fragColor; void main(){ fragColor = vec4(1.0); }";

describe("generative art evolution-speed control", () => {
  it("references a defensive Speed lookup from the uTime expression and exposes the knob", async () => {
    const scripts = captureExecScripts();
    await createGenerativeArtImpl(makeCtx(), {
      technique: "custom_glsl",
      custom_glsl_code: SHADER,
      evolution_speed: 2,
      expose_controls: true,
      parent_path: "/project1",
    });
    // uTime evolves via a guarded Speed lookup (drives live, falls back to the constant).
    const exprScript = scripts.find((s) => s.includes("vec0valuex.expr"));
    expect(exprScript).toContain("parent().par.Speed.eval()");
    expect(exprScript).toContain("hasattr(parent().par, 'Speed')");
    // The control panel appends a "Speed" custom parameter.
    const panel = scripts.find((s) => s.includes("appendCustomPage"));
    expect(panel).toBeDefined();
    const b64 = /b64decode\("([^"]+)"\)/.exec(panel ?? "")?.[1];
    if (b64 === undefined) throw new Error("panel script did not embed a base64 payload");
    const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as {
      controls: Array<{ name: string }>;
    };
    expect(payload.controls.some((c) => c.name === "Speed")).toBe(true);
  });

  it("renders strange_attractor as a real de Jong GLSL system, not the noise fallback", async () => {
    const scripts = captureExecScripts();
    const result = await createGenerativeArtImpl(makeCtx(), {
      technique: "strange_attractor",
      evolution_speed: 1,
      expose_controls: true,
      parent_path: "/project1",
    });
    // The genuine attractor shader is loaded into the GLSL TOP's pixel DAT.
    expect(scripts.some((s) => s.includes("dejong(") && s.includes("pixeldat"))).toBe(true);
    // Fine filaments need a real canvas, so a fixed square resolution is pinned.
    const resScript = scripts.find((s) => s.includes("outputresolution"));
    expect(resScript).toContain("'custom'");
    expect(resScript).toContain("resolutionw = 720");
    // It must NOT take the animated-noise fallback (which drives a noiseTOP's tz).
    expect(scripts.some((s) => s.includes(".par.tz"))).toBe(false);
    const text = result.content.find((c) => c.type === "text");
    const summary = (text as { text?: string } | undefined)?.text ?? "";
    expect(summary).toContain("(GLSL)");
    expect(summary).not.toContain("animated-noise");
  });

  it("keeps the expression defensive but skips the panel when expose_controls is off", async () => {
    const scripts = captureExecScripts();
    await createGenerativeArtImpl(makeCtx(), {
      technique: "custom_glsl",
      custom_glsl_code: SHADER,
      evolution_speed: 2,
      expose_controls: false,
      parent_path: "/project1",
    });
    expect(scripts.some((s) => s.includes("parent().par.Speed.eval()"))).toBe(true);
    expect(scripts.some((s) => s.includes("appendCustomPage"))).toBe(false);
  });
});
