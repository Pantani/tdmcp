import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { z } from "zod";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  createPoseControlnetDriverImpl,
  createPoseControlnetDriverSchema,
} from "../../src/tools/layer1/createPoseControlnetDriver.js";
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
      const body = (await request.json()) as { script: string };
      scripts.push(body.script);
      return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
    }),
  );
  return scripts;
}

function run(args: Partial<z.input<typeof createPoseControlnetDriverSchema>> = {}) {
  return createPoseControlnetDriverImpl(makeCtx(), createPoseControlnetDriverSchema.parse(args));
}

describe("create_pose_controlnet_driver", () => {
  it("happy path — existing_tracker, internal output", async () => {
    const bodies = captureCreateBodies();
    const scripts = captureExecScripts();
    const result = await run({
      source: "existing_tracker",
      pose_chop_path: "/project1/pose_tracking/pose",
      output_mode: "internal",
    });

    expect(result.isError).toBeFalsy();

    // Container created
    expect(
      bodies.find((b) => b.type === "baseCOMP" && b.name === "pose_controlnet_driver"),
    ).toBeDefined();

    // pose_norm Script CHOP + callback DAT
    expect(bodies.find((b) => b.name === "pose_norm" && b.type === "scriptCHOP")).toBeDefined();
    expect(bodies.find((b) => b.name === "pose_norm_cb" && b.type === "textDAT")).toBeDefined();

    // chopToTOP, glslTOP, nullTOP
    expect(bodies.find((b) => b.name === "pose_tex" && b.type === "choptoTOP")).toBeDefined();
    expect(bodies.find((b) => b.name === "skeleton" && b.type === "glslTOP")).toBeDefined();
    expect(bodies.find((b) => b.name === "out1" && b.type === "nullTOP")).toBeDefined();

    // GLSL shader contains LIMB_RGB[17] and JOINT_RGB[18]
    const shaderScript = scripts.find(
      (s) => s.includes("LIMB_RGB[17]") && s.includes("JOINT_RGB[18]"),
    );
    expect(shaderScript).toBeDefined();

    // Frame cooker installed
    expect(scripts.some((s) => s.includes("onFrameStart") && s.includes("cook(force=True)"))).toBe(
      true,
    );

    // No sender in output (internal mode)
    const text = textOf(result);
    expect(text).not.toContain("sender");
    expect(text).toContain("pose_controlnet_driver");
  });

  it("missing pose_chop_path → friendly error", async () => {
    const result = await run({
      source: "existing_tracker",
      // pose_chop_path deliberately omitted
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("pose_chop_path is required");
  });

  it("synthetic source — buildPoseSource Script CHOP, no external Select to pose_chop_path", async () => {
    const bodies = captureCreateBodies();
    const result = await run({
      source: "synthetic",
    });

    expect(result.isError).toBeFalsy();

    // posein should be a scriptCHOP (synthetic)
    const posein = bodies.find((b) => b.name === "posein");
    expect(posein?.type).toBe("scriptCHOP");

    // No selectCHOP pointing at an external pose path
    const hasExternalSel = bodies.some(
      (b) => b.type === "selectCHOP" && String(b.parameters?.chop ?? "").includes("pose"),
    );
    expect(hasExternalSel).toBe(false);

    // pose_norm and pipeline still created
    expect(bodies.find((b) => b.name === "pose_norm" && b.type === "scriptCHOP")).toBeDefined();
    expect(bodies.find((b) => b.name === "skeleton" && b.type === "glslTOP")).toBeDefined();
  });

  it("syphon_spout output mode — adds syphonspoutoutTOP wired from out1", async () => {
    const bodies = captureCreateBodies();
    const result = await run({
      source: "existing_tracker",
      pose_chop_path: "/project1/pose_tracking/pose",
      output_mode: "syphon_spout",
      sender_name: "my_controlnet",
    });

    expect(result.isError).toBeFalsy();

    const syphon = bodies.find((b) => b.type === "syphonspoutoutTOP");
    expect(syphon).toBeDefined();
    expect(syphon?.parameters?.senderName).toBe("my_controlnet");

    // sender info in summary text
    const text = textOf(result);
    expect(text).toMatch(/syphon|my_controlnet/i);
  });

  it("ndi output mode — adds ndioutTOP wired from out1", async () => {
    const bodies = captureCreateBodies();
    const result = await run({
      source: "existing_tracker",
      pose_chop_path: "/project1/pose_tracking/pose",
      output_mode: "ndi",
      sender_name: "ndi_controlnet",
    });

    expect(result.isError).toBeFalsy();

    const ndi = bodies.find((b) => b.type === "ndioutTOP");
    expect(ndi).toBeDefined();
    expect(ndi?.parameters?.senderName).toBe("ndi_controlnet");

    const text = textOf(result);
    expect(text).toMatch(/ndi|ndi_controlnet/i);
  });

  it("custom palette length mismatch → friendly error (limbs)", async () => {
    const result = await run({
      source: "existing_tracker",
      pose_chop_path: "/project1/pose_tracking/pose",
      color_preset: "custom",
      custom_limb_colors: Array.from({ length: 10 }, () => [255, 0, 0] as [number, number, number]),
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("expected 17 limb colors, got 10");
  });
});
