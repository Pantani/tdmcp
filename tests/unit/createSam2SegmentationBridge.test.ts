import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  createSam2SegmentationBridgeImpl,
  createSam2SegmentationBridgeSchema,
  type Sam2SegmentationBridgeReport,
} from "../../src/tools/layer1/createSam2SegmentationBridge.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

interface BridgePayload {
  parent_path: string;
  name: string;
  input_top_path: string | null;
  bridge_mode: "comfyui" | "websocket" | "ndi_mask" | "syphon_spout_mask" | "file_watch";
  server_url: string;
  mask_source_name: string | null;
  watch_folder: string | null;
  prompt_mode: "auto" | "point" | "box" | "text";
  active: boolean;
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
    .filter((content): content is { type: "text"; text: string } => content.type === "text")
    .map((content) => content.text)
    .join("\n");
}

function dataOf(result: CallToolResult): Sam2SegmentationBridgeReport {
  const match = /```json\n([\s\S]*?)\n```/.exec(textOf(result));
  const payload = match?.[1];
  if (payload === undefined) throw new Error("result did not include a JSON code fence");
  return JSON.parse(payload) as Sam2SegmentationBridgeReport;
}

function decodePayload(script: string): BridgePayload {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (b64 === undefined) throw new Error("script did not embed a base64 payload");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as BridgePayload;
}

function execOk(report: Sam2SegmentationBridgeReport) {
  return HttpResponse.json({
    ok: true,
    data: { result: null, stdout: JSON.stringify(report) },
  });
}

function successReport(
  mode: BridgePayload["bridge_mode"],
  overrides: Partial<Sam2SegmentationBridgeReport> = {},
): Sam2SegmentationBridgeReport {
  return {
    container_path: "/project1/sam2_segmentation_bridge",
    bridge_mode: mode,
    prompt_mode: "auto",
    server_url: "http://127.0.0.1:8188",
    input_top_path: null,
    mask_source_name: null,
    watch_folder: null,
    active: false,
    output_paths: {
      mask_out: "/project1/sam2_segmentation_bridge/mask_out",
      matte_out: "/project1/sam2_segmentation_bridge/matte_out",
      preview_out: "/project1/sam2_segmentation_bridge/preview_out",
    },
    nodes: {
      container: "/project1/sam2_segmentation_bridge",
      source_in: "/project1/sam2_segmentation_bridge/source_in",
      mask_receiver: "/project1/sam2_segmentation_bridge/mask_receiver",
    },
    warnings: ["Live segmentation requires an external SAM2/FastSAM service."],
    errors: [],
    ...overrides,
  };
}

describe("createSam2SegmentationBridgeSchema", () => {
  it("provides the requested defaults", () => {
    const parsed = createSam2SegmentationBridgeSchema.parse({});
    expect(parsed.parent_path).toBe("/project1");
    expect(parsed.name).toBe("sam2_segmentation_bridge");
    expect(parsed.bridge_mode).toBe("comfyui");
    expect(parsed.server_url).toBe("http://127.0.0.1:8188");
    expect(parsed.prompt_mode).toBe("auto");
    expect(parsed.active).toBe(false);
  });
});

describe("createSam2SegmentationBridgeImpl", () => {
  it("comfyui mode sends bridge fields and returns the three output TOP paths", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        capturedScript = ((await request.json()) as { script: string }).script;
        return execOk(
          successReport("comfyui", {
            prompt_mode: "box",
            server_url: "http://localhost:8188",
            input_top_path: "/project1/cam/out1",
            active: true,
          }),
        );
      }),
    );

    const result = await createSam2SegmentationBridgeImpl(makeCtx(), {
      parent_path: "/project1",
      name: "sam2_segmentation_bridge",
      input_top_path: "/project1/cam/out1",
      bridge_mode: "comfyui",
      server_url: "http://localhost:8188",
      prompt_mode: "box",
      active: true,
    });

    expect(result.isError).toBeFalsy();
    const payload = decodePayload(capturedScript);
    expect(payload.bridge_mode).toBe("comfyui");
    expect(payload.prompt_mode).toBe("box");
    expect(payload.server_url).toBe("http://localhost:8188");
    expect(payload.input_top_path).toBe("/project1/cam/out1");
    expect(payload.active).toBe(true);
    expect(capturedScript).toContain("webclientDAT");
    expect(capturedScript).toContain("nodeX");
    expect(capturedScript).toContain("result = json.dumps(report)");

    const data = dataOf(result);
    expect(data.output_paths?.mask_out).toBe("/project1/sam2_segmentation_bridge/mask_out");
    expect(data.output_paths?.matte_out).toBe("/project1/sam2_segmentation_bridge/matte_out");
    expect(data.output_paths?.preview_out).toBe("/project1/sam2_segmentation_bridge/preview_out");
    expect(textOf(result)).toContain("SAM2/FastSAM segmentation bridge created");
  });

  it("ndi_mask mode forwards source name and returns the same output contract", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        capturedScript = ((await request.json()) as { script: string }).script;
        return execOk(
          successReport("ndi_mask", {
            prompt_mode: "point",
            mask_source_name: "SAM2_MASK_MAIN",
            server_url: "http://segmenter.local:9000",
          }),
        );
      }),
    );

    const result = await createSam2SegmentationBridgeImpl(makeCtx(), {
      parent_path: "/project1",
      name: "sam2_segmentation_bridge",
      bridge_mode: "ndi_mask",
      server_url: "http://segmenter.local:9000",
      mask_source_name: "SAM2_MASK_MAIN",
      prompt_mode: "point",
      active: false,
    });

    expect(result.isError).toBeFalsy();
    const payload = decodePayload(capturedScript);
    expect(payload.bridge_mode).toBe("ndi_mask");
    expect(payload.prompt_mode).toBe("point");
    expect(payload.server_url).toBe("http://segmenter.local:9000");
    expect(payload.mask_source_name).toBe("SAM2_MASK_MAIN");
    expect(capturedScript).toContain("ndiinTOP");

    const data = dataOf(result);
    expect(data.bridge_mode).toBe("ndi_mask");
    expect(data.output_paths?.mask_out).toBe("/project1/sam2_segmentation_bridge/mask_out");
    expect(data.output_paths?.matte_out).toBe("/project1/sam2_segmentation_bridge/matte_out");
    expect(data.output_paths?.preview_out).toBe("/project1/sam2_segmentation_bridge/preview_out");
  });

  it("reported parent-missing fatal returns isError without throwing", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({
          warnings: [],
          errors: [],
          fatal: "Parent COMP not found: /missing",
        }),
      ),
    );

    await expect(
      createSam2SegmentationBridgeImpl(makeCtx(), {
        parent_path: "/missing",
        name: "sam2_segmentation_bridge",
        bridge_mode: "comfyui",
        server_url: "http://127.0.0.1:8188",
        prompt_mode: "auto",
        active: false,
      }),
    ).resolves.toMatchObject({ isError: true });
  });

  it("bridge request failures are converted into isError results", async () => {
    server.use(http.post(`${TD_BASE}/api/exec`, () => HttpResponse.error()));

    const result = await createSam2SegmentationBridgeImpl(makeCtx(), {
      parent_path: "/project1",
      name: "sam2_segmentation_bridge",
      bridge_mode: "file_watch",
      server_url: "http://127.0.0.1:8188",
      watch_folder: "/tmp/sam2_masks",
      prompt_mode: "text",
      active: false,
    });

    expect(result.isError).toBe(true);
    expect(textOf(result).length).toBeGreaterThan(0);
  });
});
