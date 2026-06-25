import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { z } from "zod";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  createDepthSilhouetteImpl,
  createDepthSilhouetteSchema,
} from "../../src/tools/layer1/createDepthSilhouette.js";
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

function dataOf(result: CallToolResult): Record<string, unknown> {
  const match = /```json\n([\s\S]*?)\n```/.exec(textOf(result));
  if (!match) throw new Error("result text did not contain a JSON block");
  const payload = match[1];
  if (payload === undefined) throw new Error("result JSON block was empty");
  return JSON.parse(payload) as Record<string, unknown>;
}

// Records every POST /api/nodes body so a test can assert which ops/params were created.
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

// Run the tool the way the MCP server does: partial args → Zod (applying defaults) → impl.
// This is what lets a test omit fields to exercise the schema defaults (e.g. the source).
function run(args: Partial<z.input<typeof createDepthSilhouetteSchema>> = {}) {
  return createDepthSilhouetteImpl(makeCtx(), createDepthSilhouetteSchema.parse(args));
}

describe("create_depth_silhouette", () => {
  it("builds a silhouette system inside a container and outputs a Null TOP", async () => {
    const result = await run({ source: "synthetic", expose_controls: false });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("/project1/depth_silhouette");
    expect(text).toContain("/project1/depth_silhouette/out1");
  });

  it("defaults to a non-device (synthetic) source so it builds with zero permissions", async () => {
    const bodies = captureCreateBodies();
    // Call with NO source given → schema default must be the device-free fallback.
    const result = await run({ expose_controls: false });
    expect(result.isError).toBeFalsy();

    const types = bodies.map((b) => b.type);
    // The non-device default uses a noise TOP as the source...
    expect(types).toContain("noiseTOP");
    // ...and creates NONE of the permission-gated depth-device ops.
    expect(types).not.toContain("kinectazureTOP");
    expect(types).not.toContain("kinectTOP");
    expect(types).not.toContain("realsenseTOP");
    expect(types).not.toContain("videodeviceinTOP");

    // The default report advertises the device-free source.
    expect(textOf(result)).toContain("synthetic");
  });

  it("keys the mask with a Threshold TOP and smooths with a Blur TOP", async () => {
    const bodies = captureCreateBodies();
    await run({ source: "synthetic", threshold: 0.62, smooth: 4, expose_controls: false });
    const mask = bodies.find((b) => b.type === "thresholdTOP");
    expect(mask?.parameters).toMatchObject({ threshold: 0.62, comparator: "greater" });
    const blur = bodies.find((b) => b.type === "blurTOP");
    expect(blur?.parameters).toMatchObject({ size: 4 });
    // A Level TOP carries the (optional) invert; here invert is off.
    const level = bodies.find((b) => b.type === "levelTOP");
    expect(level?.parameters).toMatchObject({ invert: 0 });
  });

  it("inverts the mask via the Level TOP when invert is on", async () => {
    const bodies = captureCreateBodies();
    await run({ source: "synthetic", invert: true, expose_controls: false });
    const level = bodies.find((b) => b.type === "levelTOP");
    expect(level?.parameters).toMatchObject({ invert: 1 });
  });

  it("fills the silhouette through the mask (Constant + multiply Composite) when fill_color is set", async () => {
    const bodies = captureCreateBodies();
    const result = await run({
      source: "synthetic",
      fill_color: "#ff0000",
      expose_controls: false,
    });
    const fill = bodies.find((b) => b.type === "constantTOP");
    // Red fill → colorr ~1, others 0.
    expect(fill?.parameters).toMatchObject({ colorr: 1, colorg: 0, colorb: 0 });
    const comp = bodies.find((b) => b.type === "compositeTOP");
    expect(comp?.parameters).toMatchObject({ operand: "multiply" });
    expect(textOf(result)).toContain("#ff0000");
  });

  it("brings in a file source via a Movie File In TOP (no device op)", async () => {
    const bodies = captureCreateBodies();
    await run({ source: "file", source_file_path: "/clips/depth.mov", expose_controls: false });
    const movie = bodies.find((b) => b.type === "moviefileinTOP");
    expect(movie?.parameters).toMatchObject({ file: "/clips/depth.mov" });
    expect(bodies.map((b) => b.type)).not.toContain("noiseTOP");
  });

  it("creates the confirmed depth-device op when a sensor source is chosen", async () => {
    const bodies = captureCreateBodies();
    await run({ source: "kinect_azure", expose_controls: false });
    expect(bodies.map((b) => b.type)).toContain("kinectazureTOP");
  });

  it("adds a reusable local source status DAT/CHOP surface", async () => {
    const bodies = captureCreateBodies();
    const scripts: string[] = [];
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        scripts.push(((await request.json()) as { script: string }).script);
        return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
      }),
    );

    const result = await run({ source: "kinect", expose_controls: false });
    expect(result.isError).toBeFalsy();

    expect(bodies.some((b) => b.type === "textDAT" && b.name === "source_status")).toBe(true);
    expect(bodies.some((b) => b.type === "scriptCHOP" && b.name === "source_status_chop")).toBe(
      true,
    );
    expect(
      bodies.some((b) => b.type === "textDAT" && b.name === "source_status_chop_callbacks"),
    ).toBe(true);
    expect(bodies.some((b) => b.type === "executeDAT" && b.name === "source_status_driver")).toBe(
      true,
    );

    const script = scripts.join("\n");
    expect(script).toContain('SOURCE_KIND = \\"kinect\\"');
    expect(script).toContain('SOURCE_PATH = \\"/project1/depth_silhouette/source\\"');
    expect(script).toContain('OUTPUT_PATH = \\"/project1/depth_silhouette/out1\\"');
    expect(script).toContain('parent().store(\\"tdmcp_depth_silhouette_status\\"');
    expect(script).toContain('_chan(scriptOp, \\"depth_source_ok\\"');

    const data = dataOf(result);
    expect(data.source_status_dat).toBe("/project1/depth_silhouette/source_status");
    expect(data.source_status_chop).toBe("/project1/depth_silhouette/source_status_chop");
    expect(data.source_status_driver).toBe("/project1/depth_silhouette/source_status_driver");
  });

  it("exposes Threshold/Smooth/Invert controls bound to the right params", async () => {
    const scripts: string[] = [];
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        scripts.push(((await request.json()) as { script: string }).script);
        return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
      }),
    );
    await run({ source: "synthetic", expose_controls: true });
    const panel = scripts.find((s) => s.includes("appendCustomPage"));
    expect(panel).toBeDefined();
    const b64 = /b64decode\("([^"]+)"\)/.exec(panel ?? "")?.[1];
    if (b64 === undefined) throw new Error("panel script did not embed a base64 payload");
    const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as {
      controls: Array<{ name: string; type: string; bind_to?: string[] }>;
    };
    const names = payload.controls.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(["Threshold", "Smooth", "Invert"]));
    const threshold = payload.controls.find((c) => c.name === "Threshold");
    expect(threshold?.bind_to?.[0]).toMatch(/mask\.threshold$/);
    const smooth = payload.controls.find((c) => c.name === "Smooth");
    expect(smooth?.bind_to?.[0]).toMatch(/smooth\.size$/);
    const invert = payload.controls.find((c) => c.name === "Invert");
    expect(invert?.bind_to?.[0]).toMatch(/invert\.invert$/);
  });
});
