import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  setupSegmentationImpl,
  setupSegmentationSchema,
} from "../../src/tools/layer2/setupSegmentation.js";
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

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

function mockExecWithReport(report: Record<string, unknown>): { scripts: string[] } {
  const scripts: string[] = [];
  server.use(
    http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
      const body = (await request.json()) as { script: string };
      scripts.push(body.script);
      return HttpResponse.json({
        ok: true,
        data: { result: null, stdout: JSON.stringify(report) },
      });
    }),
  );
  return { scripts };
}

const baseArgs = {
  tox_path: "/x/MediaPipe.tox",
  parent_path: "/project1",
  model: "general" as const,
  smooth: true,
  publish_prekeyed: true,
  invert_mask: false,
  feather_px: 2,
  name: "mp_segmentation",
};

describe("setup_segmentation", () => {
  it("happy path with pre-keyed branch", async () => {
    const { scripts } = mockExecWithReport({
      engine: "/project1/MediaPipe",
      mask_top: "/project1/mp_segmentation/mask",
      person_rgba_top: "/project1/mp_segmentation/person_rgba",
      model: "general",
      warnings: [],
      errors: [],
    });

    const result = await setupSegmentationImpl(makeCtx(), { ...baseArgs });

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("/project1/mp_segmentation/mask");
    expect(text).toContain("person_rgba");

    expect(scripts).toHaveLength(1);
    const script = scripts[0] as string;
    expect(script).toContain("/x/MediaPipe.tox");
    expect(script).toContain("/project1");
    expect(script).toContain("mp_segmentation");
    expect(script).toContain('MODEL = "general"');
    expect(script).toContain("FEATHER = 2");
  });

  it("pre-keyed disabled — payload includes person_rgba_top: null and summary omits prekey path", async () => {
    mockExecWithReport({
      engine: "/project1/MediaPipe",
      mask_top: "/project1/mp_segmentation/mask",
      person_rgba_top: null,
      model: "general",
      warnings: [],
      errors: [],
    });

    const result = await setupSegmentationImpl(makeCtx(), {
      ...baseArgs,
      publish_prekeyed: false,
    });

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain('"person_rgba_top": null');
    expect(text).toContain("Pre-keyed branch disabled");
  });

  it("mask not found — returns errorResult with enable hint", async () => {
    mockExecWithReport({ error: "mask_not_found", engine: "/project1/MediaPipe" });

    const result = await setupSegmentationImpl(makeCtx(), { ...baseArgs });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("enable Selfie Segmentation");
  });

  it("tox missing — guides user to install", async () => {
    mockExecWithReport({ error: "tox_missing" });

    const result = await setupSegmentationImpl(makeCtx(), {
      ...baseArgs,
      tox_path: "/nope/MediaPipe.tox",
    });

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("tdmcp install mediapipe-touchdesigner");
    expect(text).toContain("/nope/MediaPipe.tox");
  });

  it("invert + zero feather — script body contains both", async () => {
    const { scripts } = mockExecWithReport({
      engine: "/project1/MediaPipe",
      mask_top: "/project1/mp_segmentation/mask",
      person_rgba_top: "/project1/mp_segmentation/person_rgba",
      model: "general",
      warnings: [],
      errors: [],
    });

    const result = await setupSegmentationImpl(makeCtx(), {
      ...baseArgs,
      invert_mask: true,
      feather_px: 0,
    });

    expect(result.isError).toBeFalsy();
    const script = scripts[0] as string;
    expect(script).toContain("INVERT = True");
    expect(script).toContain("FEATHER = 0");
  });

  it("bridge offline — returns errorResult without throwing", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () => {
        return HttpResponse.error();
      }),
    );

    const result = await setupSegmentationImpl(makeCtx(), { ...baseArgs });

    expect(result.isError).toBe(true);
    expect(typeof textOf(result)).toBe("string");
  });

  it("schema — defaults and validation", () => {
    const parsed = setupSegmentationSchema.parse({});
    expect(parsed.parent_path).toBe("/project1");
    expect(parsed.model).toBe("general");
    expect(parsed.smooth).toBe(true);
    expect(parsed.publish_prekeyed).toBe(true);
    expect(parsed.invert_mask).toBe(false);
    expect(parsed.feather_px).toBe(2);
    expect(parsed.name).toBe("mp_segmentation");

    expect(setupSegmentationSchema.safeParse({ feather_px: 99 }).success).toBe(false);
    expect(setupSegmentationSchema.safeParse({ model: "bogus" }).success).toBe(false);
  });
});
