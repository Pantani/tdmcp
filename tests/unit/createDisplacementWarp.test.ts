import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  createDisplacementWarpImpl,
  createDisplacementWarpSchema,
} from "../../src/tools/layer1/createDisplacementWarp.js";
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
): Array<{ name: string; type?: string; default?: unknown }> {
  const panel = scripts.find((s) => s.includes("appendCustomPage"));
  const b64 = /b64decode\("([^"]+)"\)/.exec(panel ?? "")?.[1];
  if (b64 === undefined) return [];
  const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as {
    controls: Array<{ name: string; type?: string; default?: unknown }>;
  };
  return payload.controls;
}

describe("create_displacement_warp", () => {
  // ── noise modulator (default) ───────────────────────────────────────────────
  describe("noise modulator (default)", () => {
    it("builds source → noiseTOP → displaceTOP → nullTOP chain", async () => {
      const bodies = captureCreateBodies();
      const result = await createDisplacementWarpImpl(makeCtx(), {
        name: "displacement_warp",
        parent_path: "/project1",
        source: undefined,
        modulator: "noise",
        modulator_top: undefined,
        amount: 0.1,
        speed: 0.5,
        resolution: [1280, 720],
      });
      expect(result.isError).toBeFalsy();

      // Source is a Ramp TOP when no source is given.
      expect(bodies.find((b) => b.name === "source")?.type).toBe("rampTOP");
      // Modulator is a Noise TOP.
      expect(bodies.find((b) => b.name === "modulator")?.type).toBe("noiseTOP");
      // Displace and Null TOPs are present.
      expect(bodies.find((b) => b.name === "displace")?.type).toBe("displaceTOP");
      expect(bodies.find((b) => b.name === "out1")?.type).toBe("nullTOP");
      // No audio/CHOP machinery.
      expect(bodies.some((b) => b.type === "audiospectrumCHOP")).toBe(false);
      expect(bodies.some((b) => b.type === "choptoTOP")).toBe(false);
    });

    it("wires an external source via a Select TOP when source is given", async () => {
      const bodies = captureCreateBodies();
      const result = await createDisplacementWarpImpl(makeCtx(), {
        name: "displacement_warp",
        parent_path: "/project1",
        source: "/scene/render",
        modulator: "noise",
        modulator_top: undefined,
        amount: 0.1,
        speed: 0.5,
        resolution: [1280, 720],
      });
      expect(result.isError).toBeFalsy();
      const source = bodies.find((b) => b.name === "source");
      expect(source?.type).toBe("selectTOP");
      expect(source?.parameters).toMatchObject({ top: "/scene/render" });
      // No Ramp TOP when source is provided.
      expect(bodies.some((b) => b.type === "rampTOP")).toBe(false);
    });

    it("drives the noise translate with an absTime expression referencing speed", async () => {
      const scripts = captureExecScripts();
      await createDisplacementWarpImpl(makeCtx(), {
        name: "displacement_warp",
        parent_path: "/project1",
        source: undefined,
        modulator: "noise",
        modulator_top: undefined,
        amount: 0.1,
        speed: 1.5,
        resolution: [1280, 720],
      });
      const expr = scripts.find((s) => s.includes("absTime.seconds") && s.includes("tx"));
      expect(expr).toBeDefined();
      expect(expr).toContain("1.5");
    });

    it("sets displaceweight defensively on the Displace TOP", async () => {
      const scripts = captureExecScripts();
      await createDisplacementWarpImpl(makeCtx(), {
        name: "displacement_warp",
        parent_path: "/project1",
        source: undefined,
        modulator: "noise",
        modulator_top: undefined,
        amount: 0.25,
        speed: 0.5,
        resolution: [1280, 720],
      });
      // Finds the script that tries displaceweight1 first.
      const warpScript = scripts.find((s) => s.includes("displaceweight1") && s.includes("0.25"));
      expect(warpScript).toBeDefined();
      expect(warpScript).toContain("displaceweight");
    });

    it("exposes Amount + Speed knobs in the control panel", async () => {
      const scripts = captureExecScripts();
      await createDisplacementWarpImpl(makeCtx(), {
        name: "displacement_warp",
        parent_path: "/project1",
        source: undefined,
        modulator: "noise",
        modulator_top: undefined,
        amount: 0.2,
        speed: 0.8,
        resolution: [1280, 720],
      });
      const controls = panelControls(scripts);
      const amount = controls.find((c) => c.name === "Amount");
      expect(amount?.type).toBe("float");
      expect(amount?.default).toBe(0.2);
      const speed = controls.find((c) => c.name === "Speed");
      expect(speed?.type).toBe("float");
      expect(speed?.default).toBe(0.8);
    });

    it("outputs a preview image (capturePreviewImage is true)", async () => {
      const result = await createDisplacementWarpImpl(makeCtx(), {
        name: "displacement_warp",
        parent_path: "/project1",
        source: undefined,
        modulator: "noise",
        modulator_top: undefined,
        amount: 0.1,
        speed: 0.5,
        resolution: [1280, 720],
      });
      expect(result.content.some((c) => c.type === "image")).toBe(true);
    });

    it("includes the output path in the text summary", async () => {
      const result = await createDisplacementWarpImpl(makeCtx(), {
        name: "displacement_warp",
        parent_path: "/project1",
        source: undefined,
        modulator: "noise",
        modulator_top: undefined,
        amount: 0.1,
        speed: 0.5,
        resolution: [1280, 720],
      });
      const text = textOf(result);
      expect(text).toContain("/project1/displacement_warp");
      expect(text).toContain("out1");
    });
  });

  // ── second_top modulator ────────────────────────────────────────────────────
  describe("second_top modulator", () => {
    it("creates a Select TOP modulator pointing at modulator_top", async () => {
      const bodies = captureCreateBodies();
      const result = await createDisplacementWarpImpl(makeCtx(), {
        name: "displacement_warp",
        parent_path: "/project1",
        source: undefined,
        modulator: "second_top",
        modulator_top: "/vfx/displacement_map",
        amount: 0.15,
        speed: 0.5,
        resolution: [1280, 720],
      });
      expect(result.isError).toBeFalsy();

      const mod = bodies.find((b) => b.name === "modulator");
      expect(mod?.type).toBe("selectTOP");
      expect(mod?.parameters).toMatchObject({ top: "/vfx/displacement_map" });

      // No Noise TOP or audio machinery.
      expect(bodies.some((b) => b.type === "noiseTOP")).toBe(false);
      expect(bodies.some((b) => b.type === "audiospectrumCHOP")).toBe(false);
    });

    it("adds a warning when modulator_top is omitted in second_top mode", async () => {
      const result = await createDisplacementWarpImpl(makeCtx(), {
        name: "displacement_warp",
        parent_path: "/project1",
        source: undefined,
        modulator: "second_top",
        modulator_top: undefined,
        amount: 0.1,
        speed: 0.5,
        resolution: [1280, 720],
      });
      // Not a fatal error — the build still completes.
      expect(result.isError).toBeFalsy();
      const text = textOf(result);
      // The warning about missing modulator_top appears in the summary note or warnings.
      expect(text).toContain("modulator_top");
    });

    it("does NOT expose a Speed knob in second_top mode", async () => {
      const scripts = captureExecScripts();
      await createDisplacementWarpImpl(makeCtx(), {
        name: "displacement_warp",
        parent_path: "/project1",
        source: undefined,
        modulator: "second_top",
        modulator_top: "/vfx/displacement_map",
        amount: 0.15,
        speed: 0.5,
        resolution: [1280, 720],
      });
      const controls = panelControls(scripts);
      expect(controls.find((c) => c.name === "Speed")).toBeUndefined();
      expect(controls.find((c) => c.name === "Amount")).toBeDefined();
    });
  });

  // ── audio modulator ─────────────────────────────────────────────────────────
  describe("audio modulator", () => {
    it("creates an audiospectrumCHOP + choptoTOP as the modulator", async () => {
      const bodies = captureCreateBodies();
      const result = await createDisplacementWarpImpl(makeCtx(), {
        name: "displacement_warp",
        parent_path: "/project1",
        source: undefined,
        modulator: "audio",
        modulator_top: undefined,
        amount: 0.3,
        speed: 0.5,
        resolution: [1280, 720],
      });
      expect(result.isError).toBeFalsy();

      expect(bodies.some((b) => b.type === "audiospectrumCHOP")).toBe(true);
      // choptoTOP is the CHOP-to-TOP converter.
      expect(bodies.find((b) => b.name === "modulator")?.type).toBe("choptoTOP");

      // No Noise TOP.
      expect(bodies.some((b) => b.type === "noiseTOP")).toBe(false);
    });

    it("includes an audio hardware-gated note in the summary", async () => {
      const result = await createDisplacementWarpImpl(makeCtx(), {
        name: "displacement_warp",
        parent_path: "/project1",
        source: undefined,
        modulator: "audio",
        modulator_top: undefined,
        amount: 0.3,
        speed: 0.5,
        resolution: [1280, 720],
      });
      const text = textOf(result);
      expect(text).toContain("audio");
    });
  });

  // ── schema validation ───────────────────────────────────────────────────────
  describe("schema validation", () => {
    it("defaults name to 'displacement_warp'", () => {
      expect(createDisplacementWarpSchema.parse({}).name).toBe("displacement_warp");
    });

    it("defaults parent_path to '/project1'", () => {
      expect(createDisplacementWarpSchema.parse({}).parent_path).toBe("/project1");
    });

    it("defaults modulator to 'noise'", () => {
      expect(createDisplacementWarpSchema.parse({}).modulator).toBe("noise");
    });

    it("defaults amount to 0.1 and speed to 0.5", () => {
      const parsed = createDisplacementWarpSchema.parse({});
      expect(parsed.amount).toBe(0.1);
      expect(parsed.speed).toBe(0.5);
    });

    it("defaults resolution to [1280, 720]", () => {
      expect(createDisplacementWarpSchema.parse({}).resolution).toEqual([1280, 720]);
    });

    it("rejects an unknown modulator value", () => {
      expect(() => createDisplacementWarpSchema.parse({ modulator: "oscilloscope" })).toThrow();
    });

    it("rejects amount below 0", () => {
      expect(() => createDisplacementWarpSchema.parse({ amount: -1 })).toThrow();
    });
  });

  // ── fail-forward (fatal bridge error) ──────────────────────────────────────
  describe("fail-forward", () => {
    it("returns isError and does not throw when the bridge is unreachable", async () => {
      // Override /api/nodes to simulate a connection failure (HTTP 500).
      server.use(
        http.post(`${TD_BASE}/api/nodes`, () =>
          HttpResponse.json({ ok: false, error: "TD is offline" }, { status: 500 }),
        ),
      );
      let result: CallToolResult | undefined;
      await expect(
        (async () => {
          result = await createDisplacementWarpImpl(makeCtx(), {
            name: "displacement_warp",
            parent_path: "/project1",
            source: undefined,
            modulator: "noise",
            modulator_top: undefined,
            amount: 0.1,
            speed: 0.5,
            resolution: [1280, 720],
          });
        })(),
      ).resolves.not.toThrow();
      // runBuild catches TdErrors and returns an errorResult.
      expect(result?.isError).toBe(true);
    });
  });
});
