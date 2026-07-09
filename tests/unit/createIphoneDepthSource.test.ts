import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { z } from "zod";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  buildIphoneDepthSourceScript,
  createIphoneDepthSourceImpl,
  createIphoneDepthSourceSchema,
} from "../../src/tools/layer1/createIphoneDepthSource.js";
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

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

function run(args: z.input<typeof createIphoneDepthSourceSchema>) {
  return createIphoneDepthSourceImpl(makeCtx(), createIphoneDepthSourceSchema.parse(args));
}

function decodePayload(script: string): {
  parent_path: string;
  name: string;
  source: "tdlidar" | "record3d" | "generic_ndi_osc";
  video_mode: "ndi" | "syphon_spout" | "movie_file";
  video_source_name: string | null;
  movie_file: string | null;
  osc_port: number;
  sensor_prefix: string;
  create_pointcloud_stub: boolean;
  active: boolean;
} {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (b64 === undefined) throw new Error("script did not embed a base64 payload");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
}

function captureExec(report: object): { scripts: string[] } {
  const scripts: string[] = [];
  server.use(
    http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
      const body = (await request.json()) as { script: string };
      scripts.push(body.script);
      return HttpResponse.json({
        ok: true,
        data: { result: report, stdout: JSON.stringify(report) },
      });
    }),
  );
  return { scripts };
}

describe("create_iphone_depth_source", () => {
  it("embeds the payload as base64 so source names and paths survive quoting", () => {
    const payload = {
      parent_path: "/project1",
      name: "phone_depth",
      source: "record3d" as const,
      video_mode: "ndi" as const,
      video_source_name: 'Record3D "Depth"',
      movie_file: null,
      osc_port: 9123,
      sensor_prefix: "/r3d",
      create_pointcloud_stub: true,
      active: true,
    };
    expect(decodePayload(buildIphoneDepthSourceScript(payload))).toEqual(payload);
  });

  it("builds the scaffold payload and summarizes the three public outputs", async () => {
    const cap = captureExec({
      source: "record3d",
      video_mode: "ndi",
      comp: "/project1/iphone_depth_source",
      receiver: "/project1/iphone_depth_source/video_in",
      outputs: {
        color: "/project1/iphone_depth_source/color_out",
        depth: "/project1/iphone_depth_source/depth_out",
        sensors: "/project1/iphone_depth_source/sensors_out",
      },
      nodes: [
        {
          path: "/project1/iphone_depth_source/video_in",
          type: "ndiinTOP",
          name: "video_in",
          x: 0,
          y: 0,
        },
      ],
      warnings: ["Record3D needs live validation."],
    });

    const result = await run({
      source: "record3d",
      video_mode: "ndi",
      video_source_name: "Record3D Depth",
      osc_port: 9123,
      sensor_prefix: "/record3d",
      active: true,
    });

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("color_out");
    expect(text).toContain("depth_out");
    expect(text).toContain("sensors_out");

    const script = cap.scripts[0] ?? "";
    expect(script).toContain("nodeX");
    expect(script).toContain("nodeY");
    expect(script).toContain("result = report");
    expect(script).not.toContain("td.");

    const payload = decodePayload(script);
    expect(payload.source).toBe("record3d");
    expect(payload.video_mode).toBe("ndi");
    expect(payload.video_source_name).toBe("Record3D Depth");
    expect(payload.osc_port).toBe(9123);
    expect(payload.sensor_prefix).toBe("/record3d");
    expect(payload.active).toBe(true);
  });

  it("returns isError without throwing when the bridge reports a missing parent", async () => {
    captureExec({
      source: "tdlidar",
      video_mode: "ndi",
      nodes: [],
      outputs: {},
      warnings: [],
      fatal: "Parent COMP not found: /missing",
    });

    const result = await run({ parent_path: "/missing" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Could not create iPhone depth source");
    expect(textOf(result)).toContain("Parent COMP not found: /missing");
  });

  it("rejects unsupported source names at the schema boundary", () => {
    expect(() => createIphoneDepthSourceSchema.parse({ source: "arkit" })).toThrow();
  });
});
