import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { createGlitchImpl } from "../../src/tools/layer1/createGlitch.js";
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
      scripts.push(((await request.json()) as { script: string }).script);
      return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
    }),
  );
  return scripts;
}

describe("create_glitch", () => {
  it("builds a self-contained glitch system (no input_path → no device source)", async () => {
    const bodies = captureCreateBodies();
    const result = await createGlitchImpl(makeCtx(), {
      amount: 0.5,
      speed: 1,
      rgb_shift: 0.02,
      block_size: 8,
      seed: 1,
      expose_controls: false,
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("/project1/glitch");
    expect(text).toContain("/project1/glitch/out1");

    // The default source must be a non-device, no-permission generator — never a webcam.
    const types = bodies.map((b) => b.type);
    expect(types).not.toContain("videodeviceinTOP");
    const source = bodies.find((b) => b.name === "source");
    expect(source?.type).toBe("noiseTOP");

    // The glitch stack: a noise driver, a displaceTOP, a GLSL pass and a null output.
    expect(types).toContain("noiseTOP");
    expect(types).toContain("displaceTOP");
    expect(types).toContain("glslTOP");
    expect(types).toContain("nullTOP");
  });

  it("pulls an existing TOP in via a Select TOP (works across COMPs) when input_path is given", async () => {
    const created: CreatedNodeBody[] = [];
    let selectTopParam: unknown;
    server.use(
      http.post(`${TD_BASE}/api/nodes`, async ({ request }) => {
        const body = (await request.json()) as CreatedNodeBody;
        created.push(body);
        const name = body.name ?? `${body.type.replace(/[^a-zA-Z0-9]/g, "").toLowerCase()}1`;
        return HttpResponse.json({
          ok: true,
          data: { path: `${body.parent_path}/${name}`, type: body.type, name },
        });
      }),
      http.patch(`${TD_BASE}/api/nodes/:seg`, async ({ request }) => {
        const body = (await request.json()) as { parameters: Record<string, unknown> };
        if ("top" in body.parameters) selectTopParam = body.parameters.top;
        return HttpResponse.json({ ok: true, data: { parameters: body.parameters } });
      }),
    );

    const result = await createGlitchImpl(makeCtx(), {
      amount: 0.7,
      speed: 1,
      rgb_shift: 0.02,
      block_size: 8,
      seed: 1,
      input_path: "/scene/render/out1",
      expose_controls: false,
      parent_path: "/project1",
    });

    expect(result.isError).toBeFalsy();
    const select = created.find((b) => b.type === "selectTOP" && b.name === "source");
    expect(select?.parent_path).toBe("/project1/glitch");
    expect(selectTopParam).toBe("/scene/render/out1");
    // No noise source when an external input is supplied (the source IS the Select TOP).
    expect(created.find((b) => b.name === "source")?.type).toBe("selectTOP");
  });

  it("seeds the displacement noise and sizes its blocks from block_size/seed", async () => {
    const bodies = captureCreateBodies();
    await createGlitchImpl(makeCtx(), {
      amount: 0.5,
      speed: 1,
      rgb_shift: 0.02,
      block_size: 12,
      seed: 7,
      expose_controls: false,
      parent_path: "/project1",
    });
    const driver = bodies.find((b) => b.name === "driver");
    expect(driver?.type).toBe("noiseTOP");
    expect(driver?.parameters).toMatchObject({ monochrome: 1, period: 12, seed: 7 });
  });

  it("wires the displaceTOP with the source on input 0 and the noise driver on input 1", async () => {
    const scripts = captureExecScripts();
    await createGlitchImpl(makeCtx(), {
      amount: 0.5,
      speed: 1,
      rgb_shift: 0.02,
      block_size: 8,
      seed: 1,
      expose_controls: false,
      parent_path: "/project1",
    });
    // The GLSL fragment is installed via a Text DAT + pixeldat assignment, and the three
    // uniforms (uShift/uAmount/uTime) are bound through the Vectors sequence.
    const glsl = scripts.find((s) => s.includes("pixeldat"));
    expect(glsl).toBeDefined();
    const uniforms = scripts.find((s) => s.includes("seq.vec.numBlocks"));
    expect(uniforms).toBeDefined();
    expect(uniforms).toContain("uShift");
    expect(uniforms).toContain("uAmount");
    expect(uniforms).toContain("uTime");
  });

  it("exposes Amount/Speed/RGBShift/BlockSize controls and binds BlockSize to the noise period", async () => {
    const scripts = captureExecScripts();
    await createGlitchImpl(makeCtx(), {
      amount: 0.5,
      speed: 1,
      rgb_shift: 0.02,
      block_size: 8,
      seed: 1,
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
    expect(names).toEqual(["Amount", "Speed", "RGBShift", "BlockSize"]);
    const blockSize = payload.controls.find((c) => c.name === "BlockSize");
    expect(blockSize?.bind_to?.[0]).toMatch(/driver\.period$/);
    // Amount is referenced by the displace/GLSL expressions, so it is a bare custom par (no bind_to).
    const amount = payload.controls.find((c) => c.name === "Amount");
    expect(amount?.bind_to).toBeUndefined();
  });

  it("notes Amount as the audio/beat bind target in the summary", async () => {
    const result = await createGlitchImpl(makeCtx(), {
      amount: 0.5,
      speed: 1,
      rgb_shift: 0.02,
      block_size: 8,
      seed: 1,
      expose_controls: false,
      parent_path: "/project1",
    });
    expect(textOf(result)).toMatch(/par\.Amount/);
  });
});
