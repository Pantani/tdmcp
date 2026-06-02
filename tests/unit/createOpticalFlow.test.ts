import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  createOpticalFlowImpl,
  createOpticalFlowSchema,
} from "../../src/tools/layer1/createOpticalFlow.js";
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

function panelControls(
  scripts: string[],
): Array<{ name: string; type?: string; default?: unknown; min?: number; max?: number }> {
  const panel = scripts.find((s) => s.includes("appendCustomPage"));
  const b64 = /b64decode\("([^"]+)"\)/.exec(panel ?? "")?.[1];
  if (b64 === undefined) return [];
  const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as {
    controls: Array<{ name: string; type?: string; default?: unknown; min?: number; max?: number }>;
  };
  return payload.controls;
}

describe("create_optical_flow", () => {
  // ── no-arg / default source ─────────────────────────────────────────────────
  describe("default source (built-in test clip)", () => {
    it("builds container with moviefileinTOP (no source arg)", async () => {
      const bodies = captureCreateBodies();
      const result = await createOpticalFlowImpl(makeCtx(), {
        name: "optical_flow",
        parent_path: "/project1",
        source: undefined,
        resolution: [640, 360],
        sensitivity: 4.0,
        smoothing: 0.6,
        blur: 2.0,
        direction_from: "diff",
      });
      expect(result.isError).toBeFalsy();
      expect(bodies.find((b) => b.name === "movie_test")?.type).toBe("moviefileinTOP");
      expect(bodies.some((b) => b.type === "selectTOP" && b.name === "source_in")).toBe(false);
    });

    it("includes the expected core TOPs in diff mode", async () => {
      const bodies = captureCreateBodies();
      await createOpticalFlowImpl(makeCtx(), {
        name: "optical_flow",
        parent_path: "/project1",
        source: undefined,
        resolution: [640, 360],
        sensitivity: 4.0,
        smoothing: 0.6,
        blur: 2.0,
        direction_from: "diff",
      });
      const types = bodies.map((b) => b.type);
      expect(types).toContain("blurTOP");
      expect(types).toContain("monochromeTOP");
      expect(types).toContain("cacheTOP");
      expect(types).toContain("compositeTOP");
      expect(types).toContain("mathTOP");
      expect(types).toContain("levelTOP");
      expect(types).toContain("feedbackTOP");
      expect(types).toContain("nullTOP");
      // No edgeTOP in diff mode
      expect(types).not.toContain("edgeTOP");
    });

    it("summary contains output path and RG convention note", async () => {
      const result = await createOpticalFlowImpl(makeCtx(), {
        name: "optical_flow",
        parent_path: "/project1",
        source: undefined,
        resolution: [640, 360],
        sensitivity: 4.0,
        smoothing: 0.6,
        blur: 2.0,
        direction_from: "diff",
      });
      const text = textOf(result);
      expect(text).toContain("/project1/optical_flow");
      expect(text).toContain("out1");
      expect(text).toContain("0.5");
    });

    it("includes a preview image", async () => {
      const result = await createOpticalFlowImpl(makeCtx(), {
        name: "optical_flow",
        parent_path: "/project1",
        source: undefined,
        resolution: [640, 360],
        sensitivity: 4.0,
        smoothing: 0.6,
        blur: 2.0,
        direction_from: "diff",
      });
      expect(result.content.some((c) => c.type === "image")).toBe(true);
    });
  });

  // ── external source ─────────────────────────────────────────────────────────
  describe("external source via selectTOP", () => {
    it("creates source_in selectTOP with top param when source is given", async () => {
      const bodies = captureCreateBodies();
      const result = await createOpticalFlowImpl(makeCtx(), {
        name: "optical_flow",
        parent_path: "/project1",
        source: "/project1/moviein1",
        resolution: [640, 360],
        sensitivity: 4.0,
        smoothing: 0.6,
        blur: 2.0,
        direction_from: "diff",
      });
      expect(result.isError).toBeFalsy();
      const sel = bodies.find((b) => b.name === "source_in");
      expect(sel?.type).toBe("selectTOP");
      expect(sel?.parameters).toMatchObject({ top: "/project1/moviein1" });
      expect(bodies.some((b) => b.type === "moviefileinTOP")).toBe(false);
    });
  });

  // ── edges mode ──────────────────────────────────────────────────────────────
  describe("direction_from: edges", () => {
    it("creates edgeTOP and a cross compositeTOP in edges mode", async () => {
      const bodies = captureCreateBodies();
      const result = await createOpticalFlowImpl(makeCtx(), {
        name: "optical_flow",
        parent_path: "/project1",
        source: undefined,
        resolution: [640, 360],
        sensitivity: 4.0,
        smoothing: 0.6,
        blur: 2.0,
        direction_from: "edges",
      });
      expect(result.isError).toBeFalsy();
      expect(bodies.some((b) => b.type === "edgeTOP")).toBe(true);
      // Should have two compositeTOPs: diff and cross
      const compTops = bodies.filter((b) => b.type === "compositeTOP");
      expect(compTops.length).toBeGreaterThanOrEqual(2);
    });

    it("does not create edgeTOP in diff mode", async () => {
      const bodies = captureCreateBodies();
      await createOpticalFlowImpl(makeCtx(), {
        name: "optical_flow",
        parent_path: "/project1",
        source: undefined,
        resolution: [640, 360],
        sensitivity: 4.0,
        smoothing: 0.6,
        blur: 2.0,
        direction_from: "diff",
      });
      expect(bodies.some((b) => b.type === "edgeTOP")).toBe(false);
    });
  });

  // ── param mapping ────────────────────────────────────────────────────────────
  describe("param mapping", () => {
    it("passes blur to blurTOP.size", async () => {
      const bodies = captureCreateBodies();
      await createOpticalFlowImpl(makeCtx(), {
        name: "optical_flow",
        parent_path: "/project1",
        source: undefined,
        resolution: [640, 360],
        sensitivity: 4.0,
        smoothing: 0.6,
        blur: 3.5,
        direction_from: "diff",
      });
      const blur = bodies.find((b) => b.name === "pre_blur");
      expect(blur?.parameters).toMatchObject({ size: 3.5 });
    });

    it("passes sensitivity to mathTOP.gain", async () => {
      const bodies = captureCreateBodies();
      await createOpticalFlowImpl(makeCtx(), {
        name: "optical_flow",
        parent_path: "/project1",
        source: undefined,
        resolution: [640, 360],
        sensitivity: 2.0,
        smoothing: 0.6,
        blur: 2.0,
        direction_from: "diff",
      });
      const math = bodies.find((b) => b.name === "gain_math");
      expect(math?.parameters).toMatchObject({ gain: 2.0 });
    });

    it("passes resolution to created TOPs", async () => {
      const bodies = captureCreateBodies();
      await createOpticalFlowImpl(makeCtx(), {
        name: "optical_flow",
        parent_path: "/project1",
        source: undefined,
        resolution: [800, 450],
        sensitivity: 4.0,
        smoothing: 0.6,
        blur: 2.0,
        direction_from: "diff",
      });
      const blur = bodies.find((b) => b.name === "pre_blur");
      expect(blur?.parameters).toMatchObject({ resolutionw: 800, resolutionh: 450 });
    });
  });

  // ── controls ─────────────────────────────────────────────────────────────────
  describe("controls panel", () => {
    it("exposes Sensitivity, Smoothing, Blur knobs", async () => {
      const scripts = captureExecScripts();
      await createOpticalFlowImpl(makeCtx(), {
        name: "optical_flow",
        parent_path: "/project1",
        source: undefined,
        resolution: [640, 360],
        sensitivity: 4.0,
        smoothing: 0.6,
        blur: 2.0,
        direction_from: "diff",
      });
      const controls = panelControls(scripts);
      const sens = controls.find((c) => c.name === "Sensitivity");
      expect(sens?.type).toBe("float");
      expect(sens?.default).toBe(4.0);
      const smooth = controls.find((c) => c.name === "Smoothing");
      expect(smooth?.type).toBe("float");
      expect(smooth?.default).toBe(0.6);
      const blur = controls.find((c) => c.name === "Blur");
      expect(blur?.type).toBe("float");
      expect(blur?.default).toBe(2.0);
    });
  });

  // ── extra / output_path ──────────────────────────────────────────────────────
  describe("result extra", () => {
    it("unverified list mentions cacheTOP/compositeTOP/mathTOP token risks", async () => {
      const result = await createOpticalFlowImpl(makeCtx(), {
        name: "optical_flow",
        parent_path: "/project1",
        source: undefined,
        resolution: [640, 360],
        sensitivity: 4.0,
        smoothing: 0.6,
        blur: 2.0,
        direction_from: "diff",
      });
      const text = textOf(result);
      // The JSON fence should contain the unverified list
      expect(text).toContain("unverified");
      expect(text).toContain("cacheTOP");
    });
  });

  // ── schema validation ─────────────────────────────────────────────────────────
  describe("schema validation", () => {
    it("defaults name to 'optical_flow'", () => {
      expect(createOpticalFlowSchema.parse({}).name).toBe("optical_flow");
    });

    it("defaults parent_path to '/project1'", () => {
      expect(createOpticalFlowSchema.parse({}).parent_path).toBe("/project1");
    });

    it("defaults resolution to [640, 360]", () => {
      expect(createOpticalFlowSchema.parse({}).resolution).toEqual([640, 360]);
    });

    it("defaults sensitivity to 4.0", () => {
      expect(createOpticalFlowSchema.parse({}).sensitivity).toBe(4.0);
    });

    it("defaults smoothing to 0.6", () => {
      expect(createOpticalFlowSchema.parse({}).smoothing).toBe(0.6);
    });

    it("defaults blur to 2.0", () => {
      expect(createOpticalFlowSchema.parse({}).blur).toBe(2.0);
    });

    it("defaults direction_from to 'diff'", () => {
      expect(createOpticalFlowSchema.parse({}).direction_from).toBe("diff");
    });

    it("rejects an unknown direction_from value", () => {
      expect(() => createOpticalFlowSchema.parse({ direction_from: "optical" })).toThrow();
    });

    it("rejects sensitivity below 0", () => {
      expect(() => createOpticalFlowSchema.parse({ sensitivity: -1 })).toThrow();
    });

    it("rejects smoothing above 1", () => {
      expect(() => createOpticalFlowSchema.parse({ smoothing: 1.5 })).toThrow();
    });
  });

  // ── fail-forward ──────────────────────────────────────────────────────────────
  describe("fail-forward", () => {
    it("returns isError and does not throw when bridge is unreachable", async () => {
      server.use(
        http.post(`${TD_BASE}/api/nodes`, () =>
          HttpResponse.json({ ok: false, error: "TD is offline" }, { status: 500 }),
        ),
      );
      let result: CallToolResult | undefined;
      await expect(
        (async () => {
          result = await createOpticalFlowImpl(makeCtx(), {
            name: "optical_flow",
            parent_path: "/project1",
            source: undefined,
            resolution: [640, 360],
            sensitivity: 4.0,
            smoothing: 0.6,
            blur: 2.0,
            direction_from: "diff",
          });
        })(),
      ).resolves.not.toThrow();
      expect(result?.isError).toBe(true);
    });
  });
});
