import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { z } from "zod";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { createSdfFieldImpl, createSdfFieldSchema } from "../../src/tools/layer1/createSdfField.js";
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

/** Records every node creation (type) and every exec script the build issues. */
function captureBuild(): { scripts: string[]; createdTypes: string[]; connections: string[] } {
  const scripts: string[] = [];
  const createdTypes: string[] = [];
  const connections: string[] = [];
  server.use(
    http.post(`${TD_BASE}/api/nodes`, async ({ request }) => {
      const body = (await request.json()) as { parent_path: string; type: string; name?: string };
      createdTypes.push(body.type);
      const name = body.name ?? `${body.type.replace(/[^a-zA-Z0-9]/g, "").toLowerCase()}1`;
      return HttpResponse.json({
        ok: true,
        data: { path: `${body.parent_path}/${name}`, type: body.type, name },
      });
    }),
    http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
      const body = (await request.json()) as { script: string };
      scripts.push(body.script);
      return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
    }),
    http.post(`${TD_BASE}/api/connect`, async ({ request }) => {
      const body = (await request.json()) as { from: string; to: string };
      connections.push(`${body.from}->${body.to}`);
      return HttpResponse.json({ ok: true, data: {} });
    }),
  );
  return { scripts, createdTypes, connections };
}

/**
 * Calls the tool through the schema (applying defaults) exactly as the MCP framework does.
 */
function run(args: Partial<z.input<typeof createSdfFieldSchema>>) {
  return createSdfFieldImpl(makeCtx(), createSdfFieldSchema.parse(args));
}

/** Pulls the result text payload's JSON block (the `data` object finalize embeds). */
function parseResultData(result: { content: Array<{ type: string; text?: string }> }): {
  container: string;
  output: string;
  primitives: Array<{ kind: string; op: string }>;
  warnings?: string[];
} {
  const text = result.content.find((c) => c.type === "text")?.text ?? "";
  const json = /```json\n([\s\S]+?)\n```/.exec(text)?.[1];
  if (!json) throw new Error("result did not embed a JSON data block");
  return JSON.parse(json);
}

describe("createSdfField schema", () => {
  it("defaults to a single unit sphere with sensible params", () => {
    const parsed = createSdfFieldSchema.parse({});
    expect(parsed.primitives).toHaveLength(1);
    expect(parsed.primitives[0]?.kind).toBe("sphere");
    expect(parsed.primitives[0]?.op).toBe("union");
    expect(parsed.camera_z).toBe(4);
    expect(parsed.speed).toBe(1);
    expect(parsed.step_count).toBe(96);
    expect(parsed.intensity).toBe(1);
    expect(parsed.rotate_scene).toBe(0);
    expect(parsed.resolution).toEqual([1280, 720]);
    expect(parsed.expose_controls).toBe(true);
    expect(parsed.parent_path).toBe("/project1");
    expect(parsed.color_a).toBe("#33ccff");
    expect(parsed.color_b).toBe("#ff2266");
    expect(parsed.background).toBe("#06080c");
    expect(parsed.light_direction).toEqual([0.6, 0.8, 0.4]);
    expect(parsed.camera_target).toEqual([0, 0, 0]);
  });

  it("rejects more than 16 primitives", () => {
    const prim = { kind: "sphere" as const, op: "union" as const };
    expect(() => createSdfFieldSchema.parse({ primitives: Array(17).fill(prim) })).toThrow();
  });

  it("accepts exactly 16 primitives", () => {
    const prim = { kind: "sphere" as const, op: "union" as const };
    const parsed = createSdfFieldSchema.parse({ primitives: Array(16).fill(prim) });
    expect(parsed.primitives).toHaveLength(16);
  });

  it("clamps step_count to 8..256 integer range", () => {
    expect(() => createSdfFieldSchema.parse({ step_count: 4 })).toThrow();
    expect(() => createSdfFieldSchema.parse({ step_count: 512 })).toThrow();
    expect(createSdfFieldSchema.parse({ step_count: 128 }).step_count).toBe(128);
  });

  it("rejects empty primitives array", () => {
    expect(() => createSdfFieldSchema.parse({ primitives: [] })).toThrow();
  });

  it("clamps blend to 0..1", () => {
    expect(() =>
      createSdfFieldSchema.parse({
        primitives: [{ kind: "sphere", op: "union", blend: 1.5 }],
      }),
    ).toThrow();
  });
});

describe("createSdfField build — node topology", () => {
  it("creates baseCOMP, glslTOP, textDAT and nullTOP", async () => {
    const { createdTypes } = captureBuild();
    await run({});
    expect(createdTypes).toContain("baseCOMP");
    expect(createdTypes).toContain("glslTOP");
    expect(createdTypes).toContain("textDAT");
    expect(createdTypes).toContain("nullTOP");
  });

  it("returns a result with the container at /project1/sdf_field and output at /out1", async () => {
    captureBuild();
    const result = await run({});
    const data = parseResultData(result as never);
    expect(data.container).toMatch(/\/project1\/sdf_field/);
    expect(data.output).toMatch(/\/out1$/);
  });

  it("echoes primitives, camera_z, resolution, light_direction, camera_target in extra", async () => {
    captureBuild();
    const result = await run({
      camera_z: 6,
      light_direction: [1, 0, 0],
      camera_target: [0, 1, 0],
      resolution: [1920, 1080],
    });
    const data = parseResultData(result as never);
    expect(data.primitives).toHaveLength(1);
    const raw = result as { content: Array<{ text?: string }> };
    const text = raw.content.find((c) => c.text)?.text ?? "";
    expect(text).toContain('"camera_z": 6');
    expect(text).toContain('"resolution"');
  });
});

describe("createSdfField build — fragment shader", () => {
  it("writes sdSphere, sceneDist, TDOutputSwizzle, uTime in the text DAT script", async () => {
    const { scripts } = captureBuild();
    await run({});
    const textScript = scripts.find((s) => s.includes(".text =") && s.includes("pixeldat"));
    expect(textScript).toBeDefined();
    expect(textScript).toContain("sdSphere");
    expect(textScript).toContain("sceneDist");
    expect(textScript).toContain("TDOutputSwizzle");
    expect(textScript).toContain("uTime");
    expect(textScript).toContain("out vec4 fragColor");
  });

  it("CSG fold — sphere+union, box+subtract, torus+union blend=0.3 → sdBox, sdTorus, smin(, max(d, -d", async () => {
    const { scripts } = captureBuild();
    await run({
      primitives: [
        { kind: "sphere", op: "union", position: [0, 0, 0], size: 1, thickness: 0.3, blend: 0 },
        { kind: "box", op: "subtract", position: [0.5, 0, 0], size: 0.8, thickness: 0.3, blend: 0 },
        { kind: "torus", op: "union", position: [0, 0, 0], size: 1, thickness: 0.3, blend: 0.3 },
      ],
    });
    const textScript = scripts.find((s) => s.includes(".text =") && s.includes("pixeldat"));
    expect(textScript).toBeDefined();
    expect(textScript).toContain("sdBox");
    expect(textScript).toContain("sdTorus");
    expect(textScript).toContain("smin(");
    expect(textScript).toContain("max(d, -d");
  });

  it("uses uBackground for miss colour instead of a hard-coded tint", async () => {
    const { scripts } = captureBuild();
    await run({});
    const textScript = scripts.find((s) => s.includes(".text =") && s.includes("pixeldat"));
    expect(textScript).toContain("uBackground");
  });

  it("includes uRotate uniform and applies a y-axis rotation in sceneDist", async () => {
    const { scripts } = captureBuild();
    await run({ rotate_scene: 0.5 });
    const textScript = scripts.find((s) => s.includes(".text =") && s.includes("pixeldat"));
    expect(textScript).toContain("uniform float uRotate");
    expect(textScript).toContain("uRotate");
    expect(textScript).toContain("uTime * uRotate");
  });
});

describe("createSdfField build — uniforms", () => {
  it("binds vec0=uTime, vec1=uCameraZ, vec4=uRotate via Vectors sequence", async () => {
    const { scripts } = captureBuild();
    await run({});
    const uniformScript = scripts.find((s) => s.includes("vec0name = 'uTime'"));
    expect(uniformScript).toBeDefined();
    expect(uniformScript).toContain("vec0name = 'uTime'");
    expect(uniformScript).toContain("vec1name = 'uCameraZ'");
    expect(uniformScript).toContain("vec4name = 'uRotate'");
    expect(uniformScript).toContain("absTime.seconds");
    expect(uniformScript).toContain("parent().par.Speed.eval()");
    expect(uniformScript).toContain("hasattr(parent().par, 'Speed')");
    expect(uniformScript).toContain("parent().par.Cameraz.eval()");
    expect(uniformScript).toContain("parent().par.Rotate.eval()");
    // 5 blocks required
    expect(uniformScript).toContain("max(_g.seq.vec.numBlocks, 5)");
  });

  it("binds color2=uBackground via Colors sequence", async () => {
    const { scripts } = captureBuild();
    await run({});
    const uniformScript = scripts.find((s) => s.includes("color2name = 'uBackground'"));
    expect(uniformScript).toBeDefined();
    expect(uniformScript).toContain("color2rgbr.expr");
    expect(uniformScript).toContain("parent().par.Backgroundr.eval()");
    // 3 color blocks
    expect(uniformScript).toContain("max(_g.seq.color.numBlocks, 3)");
  });
});

describe("createSdfField build — controls", () => {
  it("exposes 8 live controls when expose_controls=true", async () => {
    const { scripts } = captureBuild();
    await run({ expose_controls: true });
    const panel = scripts.find((s) => s.includes("appendCustomPage"));
    expect(panel).toBeDefined();
    const b64 = /b64decode\("([^"]+)"\)/.exec(panel ?? "")?.[1];
    if (!b64) throw new Error("panel script did not embed a base64 payload");
    const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as {
      controls: Array<{ name: string; type: string }>;
    };
    const names = payload.controls.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "CameraZ",
        "Speed",
        "StepCount",
        "Intensity",
        "Rotate",
        "ColorA",
        "ColorB",
        "Background",
      ]),
    );
    expect(payload.controls.find((c) => c.name === "StepCount")?.type).toBe("int");
    expect(payload.controls.find((c) => c.name === "ColorA")?.type).toBe("rgb");
    expect(payload.controls.find((c) => c.name === "Background")?.type).toBe("rgb");
  });

  it("skips the control panel when expose_controls=false", async () => {
    const { scripts } = captureBuild();
    await run({ expose_controls: false });
    expect(scripts.some((s) => s.includes("appendCustomPage"))).toBe(false);
    // Defensive expressions are always written
    expect(scripts.some((s) => s.includes("parent().par.Speed.eval()"))).toBe(true);
  });
});

describe("createSdfField build — hex colour handling", () => {
  it("parses a valid hex and uses it as fallback in color0rgbr.expr", async () => {
    const { scripts } = captureBuild();
    await run({ color_a: "#ff0000" });
    const uniformScript = scripts.find((s) => s.includes("color0rgbr.expr"));
    expect(uniformScript).toBeDefined();
    // red channel = 1.0
    expect(uniformScript).toContain("else 1");
  });

  it("warns (but still builds) on a malformed color_a", async () => {
    captureBuild();
    const result = await run({ color_a: "not-a-color" });
    const data = parseResultData(result as never);
    expect((data.warnings ?? []).some((w) => /could not parse color_a/i.test(w))).toBe(true);
  });

  it("never throws when color_a is bad (isError absent or warns gracefully)", async () => {
    captureBuild();
    let result: Awaited<ReturnType<typeof run>> | undefined;
    await expect(
      (async () => {
        result = await run({ color_a: "???" });
      })(),
    ).resolves.not.toThrow();
    // Result should still exist (no fatal error from a bad colour alone)
    expect(result).toBeDefined();
  });
});
