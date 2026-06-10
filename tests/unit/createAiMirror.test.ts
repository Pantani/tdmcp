import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

// Module-mock the FM-04 foundation. The combo's job is to delegate, parse the
// envelope, and wire a panel — not to re-cover drive_streamdiffusion's surface.
const sdImplMock = vi.hoisted(() => vi.fn());
vi.mock("../../src/tools/layer1/driveStreamdiffusion.js", () => ({
  driveStreamdiffusionImpl: sdImplMock,
}));

import { createAiMirrorImpl, createAiMirrorSchema } from "../../src/tools/layer1/createAiMirror.js";

interface CreatedNodeBody {
  parent_path: string;
  type: string;
  name?: string;
  parameters?: Record<string, unknown>;
}

const server = makeTdServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
  sdImplMock.mockReset();
});
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

/**
 * Build a CallToolResult envelope shaped like drive_streamdiffusion's real
 * return: a text part containing a ```json``` block with the documented fields.
 */
function fakeSdResult(opts: {
  validatedPars?: string[];
  outputTopPath?: string;
  containerPath?: string;
  isError?: boolean;
}): CallToolResult {
  const payload = {
    container_path:
      opts.containerPath ?? "/project1/ai_mirror/streamdiffusion_driver/StreamDiffusionTD",
    output_top_path: opts.outputTopPath ?? "/project1/ai_mirror/streamdiffusion_driver/out1",
    validated_pars: opts.validatedPars ?? ["Prompt", "Strength", "Cfg", "Seed"],
  };
  const result: CallToolResult = {
    content: [
      {
        type: "text",
        text: `Built StreamDiffusion driver.\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``,
      },
    ],
  };
  if (opts.isError) result.isError = true;
  return result;
}

function run(args: Partial<z.input<typeof createAiMirrorSchema>> = {}) {
  return createAiMirrorImpl(makeCtx(), createAiMirrorSchema.parse(args));
}

describe("create_ai_mirror", () => {
  it("happy path — synthetic + internal + panel", async () => {
    sdImplMock.mockResolvedValueOnce(fakeSdResult({}));
    const bodies = captureCreateBodies();
    const scripts = captureExecScripts();

    const result = await run({
      source: "synthetic",
      output_mode: "internal",
      expose_control_panel: true,
    });

    expect(result.isError).toBeFalsy();
    expect(sdImplMock).toHaveBeenCalledTimes(1);
    const sdCallArgs = sdImplMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(sdCallArgs.output_mode).toBe("internal");
    expect(sdCallArgs.source_top_path).toBe("/project1/ai_mirror/sd_in");

    // ai_mirror container + showcase ops
    expect(bodies.find((b) => b.type === "baseCOMP" && b.name === "ai_mirror")).toBeDefined();
    expect(bodies.find((b) => b.name === "cam_in" && b.type === "noiseTOP")).toBeDefined();
    expect(bodies.find((b) => b.name === "sd_in" && b.type === "nullTOP")).toBeDefined();
    expect(bodies.find((b) => b.name === "out" && b.type === "nullTOP")).toBeDefined();

    // Panel + children
    expect(bodies.find((b) => b.name === "panel" && b.type === "containerCOMP")).toBeDefined();
    expect(bodies.find((b) => b.name === "prompt_text" && b.type === "textDAT")).toBeDefined();
    expect(bodies.find((b) => b.name === "neg_prompt_text" && b.type === "textDAT")).toBeDefined();
    expect(
      bodies.find((b) => b.name === "strength_slider" && b.type === "sliderCOMP"),
    ).toBeDefined();
    expect(bodies.find((b) => b.name === "cfg_slider" && b.type === "sliderCOMP")).toBeDefined();
    expect(bodies.find((b) => b.name === "preview_cam" && b.type === "selectTOP")).toBeDefined();
    expect(bodies.find((b) => b.name === "status_text" && b.type === "textDAT")).toBeDefined();

    // Wires SD pars via .expr + EXPRESSION mode
    expect(scripts.some((s) => s.includes(".expr") && s.includes("EXPRESSION"))).toBe(true);
    // Panel binds Prompt/Strength/Cfg expressions
    expect(scripts.some((s) => s.includes("'Prompt'") || s.includes('"Prompt"'))).toBe(true);
  });

  it("camera source — videodeviceinTOP with given device index", async () => {
    sdImplMock.mockResolvedValueOnce(fakeSdResult({}));
    const bodies = captureCreateBodies();

    const result = await run({
      source: "camera",
      camera_device_idx: 2,
      output_mode: "syphon_spout",
      output_sender_name: "ai_mirror_test",
    });

    expect(result.isError).toBeFalsy();
    const camIn = bodies.find((b) => b.name === "cam_in" && b.type === "videodeviceinTOP");
    expect(camIn).toBeDefined();
    expect(camIn?.parameters?.device).toBe(2);

    // FM-04 called with syphon_spout + sender name
    const sdCallArgs = sdImplMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(sdCallArgs.output_mode).toBe("syphon_spout");
    expect(sdCallArgs.output_name).toBe("ai_mirror_test");

    // Camera UNVERIFIED warning surfaced via finalize's json block
    expect(textOf(result)).toMatch(/UNVERIFIED/);
  });

  it("output_mode ndi propagates verbatim", async () => {
    sdImplMock.mockResolvedValueOnce(fakeSdResult({}));
    captureCreateBodies();

    const result = await run({
      source: "synthetic",
      output_mode: "ndi",
      output_sender_name: "ai_mirror_ndi",
    });
    expect(result.isError).toBeFalsy();
    const sdCallArgs = sdImplMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(sdCallArgs.output_mode).toBe("ndi");
    expect(sdCallArgs.output_name).toBe("ai_mirror_ndi");
    expect(textOf(result)).toContain("ai_mirror_ndi");
  });

  it("no panel — expose_control_panel=false leaves panel ops out", async () => {
    sdImplMock.mockResolvedValueOnce(fakeSdResult({}));
    const bodies = captureCreateBodies();

    const result = await run({
      source: "synthetic",
      expose_control_panel: false,
    });

    expect(result.isError).toBeFalsy();
    expect(bodies.find((b) => b.name === "panel")).toBeUndefined();
    expect(bodies.find((b) => b.name === "strength_slider")).toBeUndefined();
    expect(bodies.find((b) => b.name === "prompt_text")).toBeUndefined();
    // result envelope has control_panel_path = undefined → not serialized
    expect(textOf(result)).not.toMatch(/control_panel_path"\s*:\s*"/);
  });

  it("SD precheck-tox-missing error → graceful degradation: skeleton built, warning surfaced, not isError", async () => {
    // Precheck signature: isError + text containing "not found" / "Install" / "no_candidate_found"
    const precheckError: CallToolResult = {
      isError: true,
      content: [
        {
          type: "text",
          text: "StreamDiffusionTD.tox not found (no_candidate_found). Install from https://github.com/cumulo-autumn/StreamDiffusion",
        },
      ],
    };
    sdImplMock.mockResolvedValueOnce(precheckError);
    const bodies = captureCreateBodies();

    const result = await run({ source: "synthetic", expose_control_panel: false });

    // Must NOT abort — isError should be falsy
    expect(result.isError).toBeFalsy();
    // Skeleton ops still created
    expect(bodies.find((b) => b.name === "sd_in" && b.type === "nullTOP")).toBeDefined();
    expect(bodies.find((b) => b.name === "out" && b.type === "nullTOP")).toBeDefined();
    // SD friendly message surfaced in warnings
    const text = textOf(result);
    expect(text).toMatch(/skeleton built without SD pars/i);
  });

  it("SD fatal runBuild error (non-precheck) → surfaces error directly", async () => {
    const fatalError: CallToolResult = {
      isError: true,
      content: [{ type: "text", text: "TouchDesigner connection refused" }],
    };
    sdImplMock.mockResolvedValueOnce(fatalError);
    captureCreateBodies();

    const result = await run({ source: "synthetic" });

    // Fatal error must propagate
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("TouchDesigner connection refused");
  });

  it("camera failure with fallback_to_synthetic builds noiseTOP", async () => {
    sdImplMock.mockResolvedValueOnce(fakeSdResult({}));

    // Fail only the videodeviceinTOP creation; everything else succeeds.
    const bodies: CreatedNodeBody[] = [];
    server.use(
      http.post(`${TD_BASE}/api/nodes`, async ({ request }) => {
        const body = (await request.json()) as CreatedNodeBody;
        if (body.type === "videodeviceinTOP") {
          return HttpResponse.json(
            { ok: false, error: { message: "no camera device" } },
            { status: 500 },
          );
        }
        bodies.push(body);
        const name = body.name ?? `${body.type.replace(/[^a-zA-Z0-9]/g, "").toLowerCase()}1`;
        return HttpResponse.json({
          ok: true,
          data: { path: `${body.parent_path}/${name}`, type: body.type, name },
        });
      }),
    );

    const result = await run({
      source: "camera",
      fallback_to_synthetic: true,
      output_mode: "internal",
    });

    expect(result.isError).toBeFalsy();
    // cam_in was rebuilt as noiseTOP
    expect(bodies.find((b) => b.name === "cam_in" && b.type === "noiseTOP")).toBeDefined();
    expect(textOf(result)).toMatch(/fallback_to_synthetic|synthetic/i);
  });
});
