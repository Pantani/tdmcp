import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  buildOrbbecDepthSilhouetteScript,
  createOrbbecDepthSilhouetteImpl,
  createOrbbecDepthSilhouetteSchema,
  type OrbbecDepthSilhouetteReport,
} from "../../src/tools/layer1/createOrbbecDepthSilhouette.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

interface OrbbecPayload {
  parent_path: string;
  name: string;
  source: "orbbec_top" | "kinect_azure_orbbec" | "file" | "synthetic";
  source_top_path: string | null;
  movie_file: string | null;
  near_threshold: number;
  far_threshold: number;
  smooth: number;
  invert: boolean;
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

function decodePayload(script: string): OrbbecPayload {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (b64 === undefined) throw new Error("script did not embed a base64 payload");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as OrbbecPayload;
}

function execOk(report: OrbbecDepthSilhouetteReport) {
  return HttpResponse.json({ ok: true, data: { result: null, stdout: JSON.stringify(report) } });
}

describe("create_orbbec_depth_silhouette", () => {
  it("round-trips threshold and source fields through the base64 payload", () => {
    const payload: OrbbecPayload = {
      parent_path: "/project1",
      name: "orb",
      source: "orbbec_top",
      source_top_path: "/project1/depth",
      movie_file: null,
      near_threshold: 0.1,
      far_threshold: 0.7,
      smooth: 2.5,
      invert: true,
      active: true,
    };
    expect(decodePayload(buildOrbbecDepthSilhouetteScript(payload))).toEqual(payload);
  });

  it("returns stable silhouette and depth preview paths on synthetic success", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        capturedScript = ((await request.json()) as { script: string }).script;
        return execOk({
          container_path: "/project1/orbbec_depth_silhouette",
          source: "synthetic",
          depth_source: "/project1/orbbec_depth_silhouette/depth_source",
          depth_preview: "/project1/orbbec_depth_silhouette/depth_preview",
          silhouette_out: "/project1/orbbec_depth_silhouette/silhouette_out",
          sensor_status: "/project1/orbbec_depth_silhouette/sensor_status",
          setup_dat: "/project1/orbbec_depth_silhouette/setup_notes",
          warnings: ["Live Orbbec hardware path is unverified."],
        });
      }),
    );

    const result = await createOrbbecDepthSilhouetteImpl(
      makeCtx(),
      createOrbbecDepthSilhouetteSchema.parse({ smooth: 3, near_threshold: 0.2 }),
    );

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("silhouette_out");
    expect(textOf(result)).toContain("depth_preview");
    expect(capturedScript).toContain("orbbecTOP");
    expect(capturedScript).toContain("nodeY");
    expect(decodePayload(capturedScript).smooth).toBe(3);
  });

  it("surfaces Orbbec-mode warnings without marking success as fatal", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({
          container_path: "/project1/orbbec_depth_silhouette",
          source: "orbbec_top",
          silhouette_out: "/project1/orbbec_depth_silhouette/silhouette_out",
          depth_preview: "/project1/orbbec_depth_silhouette/depth_preview",
          warnings: ["Orbbec TOP source requires live Orbbec SDK/device validation."],
        }),
      ),
    );

    const result = await createOrbbecDepthSilhouetteImpl(
      makeCtx(),
      createOrbbecDepthSilhouetteSchema.parse({ source: "orbbec_top" }),
    );

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("Orbbec SDK");
  });

  it("returns isError for fatal reports and rejects invalid threshold ordering", async () => {
    expect(() =>
      createOrbbecDepthSilhouetteSchema.parse({ near_threshold: 0.9, far_threshold: 0.1 }),
    ).toThrow();

    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ source: "synthetic", warnings: [], fatal: "Parent COMP not found: /missing" }),
      ),
    );

    await expect(
      createOrbbecDepthSilhouetteImpl(
        makeCtx(),
        createOrbbecDepthSilhouetteSchema.parse({ parent_path: "/missing" }),
      ),
    ).resolves.toMatchObject({ isError: true });
  });
});
