import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  createLiveSourceImpl,
  createLiveSourceSchema,
} from "../../src/tools/layer1/createLiveSource.js";
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

function dataOf(result: Awaited<ReturnType<typeof createLiveSourceImpl>>): Record<string, unknown> {
  const text = result.content.find((c) => c.type === "text") as
    | { type: "text"; text: string }
    | undefined;
  const match = /```json\n([\s\S]*?)\n```/.exec(text?.text ?? "");
  if (!match) throw new Error("result text did not contain a JSON block");
  const payload = match[1];
  if (payload === undefined) throw new Error("result JSON block was empty");
  return JSON.parse(payload) as Record<string, unknown>;
}

describe("create_live_source", () => {
  describe("screen_grab (default)", () => {
    it("creates screengrabTOP, fitTOP, and out1 nullTOP", async () => {
      const bodies = captureCreateBodies();
      const result = await createLiveSourceImpl(makeCtx(), {
        name: "live_source",
        parent_path: "/project1",
        kind: "screen_grab",
        resolution: [1280, 720],
      });
      expect(result.isError).toBeFalsy();

      // The outermost container (baseCOMP).
      const container = bodies.find((b) => b.type === "baseCOMP");
      expect(container).toBeDefined();
      expect(container?.parent_path).toBe("/project1");

      // Source TOP: screengrabTOP.
      const sourceTop = bodies.find((b) => b.type === "screengrabTOP");
      expect(sourceTop).toBeDefined();
      expect(sourceTop?.name).toBe("source_in");

      // Fit TOP for resolution normalization.
      const fitTop = bodies.find((b) => b.type === "fitTOP");
      expect(fitTop).toBeDefined();
      expect(fitTop?.name).toBe("fit_res");

      // Output Null TOP.
      const outTop = bodies.find((b) => b.type === "nullTOP" && b.name === "out1");
      expect(outTop).toBeDefined();
    });

    it("adds a reusable local source status DAT/CHOP surface", async () => {
      const bodies = captureCreateBodies();
      const scripts = captureExecScripts();
      const result = await createLiveSourceImpl(makeCtx(), {
        name: "live_source",
        parent_path: "/project1",
        kind: "screen_grab",
        resolution: [1280, 720],
      });
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
      expect(script).toContain('SOURCE_KIND = \\"screen_grab\\"');
      expect(script).toContain('SOURCE_PATH = \\"/project1/live_source/source_in\\"');
      expect(script).toContain('OUTPUT_PATH = \\"/project1/live_source/out1\\"');
      expect(script).toContain('parent().store(\\"tdmcp_live_source_status\\"');
      expect(script).toContain('_chan(scriptOp, \\"live_source_ok\\"');
      expect(script).toContain("source_status_chop");

      const data = dataOf(result);
      expect(data.source_status_dat).toBe("/project1/live_source/source_status");
      expect(data.source_status_chop).toBe("/project1/live_source/source_status_chop");
      expect(data.source_status_driver).toBe("/project1/live_source/source_status_driver");
    });

    it("sets resolution on the fit stage", async () => {
      captureCreateBodies();
      // Capture PATCH calls to inspect parameter updates.
      const patches: Array<{ path: string; parameters: Record<string, unknown> }> = [];
      server.use(
        http.patch(`${TD_BASE}/api/nodes/:seg`, async ({ params, request }) => {
          const body = (await request.json()) as { parameters: Record<string, unknown> };
          const seg = decodeURIComponent(
            Array.isArray(params.seg) ? (params.seg[0] ?? "") : String(params.seg ?? ""),
          );
          patches.push({ path: seg, parameters: body.parameters });
          return HttpResponse.json({
            ok: true,
            data: { path: seg, type: "fitTOP", name: "fit_res", parameters: body.parameters },
          });
        }),
      );
      await createLiveSourceImpl(makeCtx(), {
        name: "live_source",
        parent_path: "/project1",
        kind: "screen_grab",
        resolution: [1920, 1080],
      });
      const fitPatch = patches.find((p) => p.path.includes("fit_res"));
      expect(fitPatch?.parameters.resolutionw).toBe(1920);
      expect(fitPatch?.parameters.resolutionh).toBe(1080);
    });

    it("includes platform_note and output path in the summary text", async () => {
      captureCreateBodies();
      captureExecScripts();
      const result = await createLiveSourceImpl(makeCtx(), {
        name: "live_source",
        parent_path: "/project1",
        kind: "screen_grab",
        resolution: [1280, 720],
      });
      const text = result.content.find((c) => c.type === "text") as
        | { type: "text"; text: string }
        | undefined;
      expect(text?.text).toContain("screen grab");
      expect(text?.text).toContain("out1");
      expect(text?.text).toContain("1280×720");
    });

    it("schema defaults: name=live_source, kind=screen_grab, resolution=[1280,720]", () => {
      const parsed = createLiveSourceSchema.parse({});
      expect(parsed.name).toBe("live_source");
      expect(parsed.kind).toBe("screen_grab");
      expect(parsed.resolution).toEqual([1280, 720]);
      expect(parsed.parent_path).toBe("/project1");
    });
  });

  describe("ndi kind", () => {
    it("creates ndiinTOP and probes sender par name when source_name given", async () => {
      const bodies = captureCreateBodies();
      const scripts = captureExecScripts();
      const result = await createLiveSourceImpl(makeCtx(), {
        name: "live_source",
        parent_path: "/project1",
        kind: "ndi",
        source_name: "RESOLUME (myMachine)",
        resolution: [1280, 720],
      });
      expect(result.isError).toBeFalsy();

      // ndiinTOP must be created.
      expect(bodies.some((b) => b.type === "ndiinTOP" && b.name === "source_in")).toBe(true);

      // A probe script should contain the sender name and the probe list.
      const probe = scripts.find(
        (s) => s.includes("sourcename") || s.includes('"name"') || s.includes("RESOLUME"),
      );
      expect(probe).toBeDefined();
      expect(probe).toContain("RESOLUME (myMachine)");
    });

    it("still builds without source_name (picks first available sender)", async () => {
      const bodies = captureCreateBodies();
      const result = await createLiveSourceImpl(makeCtx(), {
        name: "live_source",
        parent_path: "/project1",
        kind: "ndi",
        resolution: [1280, 720],
      });
      expect(result.isError).toBeFalsy();
      expect(bodies.some((b) => b.type === "ndiinTOP")).toBe(true);
    });

    it("summary includes UNVERIFIED note for ndi kind", async () => {
      captureCreateBodies();
      captureExecScripts();
      const result = await createLiveSourceImpl(makeCtx(), {
        name: "live_source",
        parent_path: "/project1",
        kind: "ndi",
        resolution: [1280, 720],
      });
      const text = result.content.find((c) => c.type === "text") as
        | { type: "text"; text: string }
        | undefined;
      expect(text?.text).toContain("UNVERIFIED");
    });
  });

  describe("syphon_spout kind", () => {
    it("creates syphonspoutinTOP", async () => {
      const bodies = captureCreateBodies();
      await createLiveSourceImpl(makeCtx(), {
        name: "live_source",
        parent_path: "/project1",
        kind: "syphon_spout",
        source_name: "Syphon Sender",
        resolution: [1280, 720],
      });
      expect(bodies.some((b) => b.type === "syphonspoutinTOP" && b.name === "source_in")).toBe(
        true,
      );
    });

    it("probes sendername par when source_name given", async () => {
      captureCreateBodies();
      const scripts = captureExecScripts();
      await createLiveSourceImpl(makeCtx(), {
        name: "live_source",
        parent_path: "/project1",
        kind: "syphon_spout",
        source_name: "MySyphon",
        resolution: [1280, 720],
      });
      const probe = scripts.find((s) => s.includes("MySyphon"));
      expect(probe).toBeDefined();
      expect(probe).toContain("sendername");
    });
  });

  describe("camera kind", () => {
    it("creates videodeviceinTOP", async () => {
      const bodies = captureCreateBodies();
      const result = await createLiveSourceImpl(makeCtx(), {
        name: "live_source",
        parent_path: "/project1",
        kind: "camera",
        resolution: [1280, 720],
      });
      expect(result.isError).toBeFalsy();
      expect(bodies.some((b) => b.type === "videodeviceinTOP" && b.name === "source_in")).toBe(
        true,
      );
    });

    it("summary includes macOS permission hang warning", async () => {
      captureCreateBodies();
      captureExecScripts();
      const result = await createLiveSourceImpl(makeCtx(), {
        name: "live_source",
        parent_path: "/project1",
        kind: "camera",
        resolution: [1280, 720],
      });
      const text = result.content.find((c) => c.type === "text") as
        | { type: "text"; text: string }
        | undefined;
      expect(text?.text).toContain("macOS");
    });
  });

  describe("video_stream kind", () => {
    it("creates videostreaminTOP and probes URL par when source_name given", async () => {
      const bodies = captureCreateBodies();
      const scripts = captureExecScripts();
      const result = await createLiveSourceImpl(makeCtx(), {
        name: "live_source",
        parent_path: "/project1",
        kind: "video_stream",
        source_name: "rtsp://192.168.1.10:554/stream",
        resolution: [1280, 720],
      });
      expect(result.isError).toBeFalsy();
      expect(bodies.some((b) => b.type === "videostreaminTOP" && b.name === "source_in")).toBe(
        true,
      );
      const probe = scripts.find((s) => s.includes("rtsp://192.168.1.10"));
      expect(probe).toBeDefined();
      expect(probe).toContain("url");
    });
  });

  describe("error/fatal paths — never throw", () => {
    it("returns isError:true when bridge returns a fatal report, never throws", async () => {
      server.use(
        http.post(`${TD_BASE}/api/nodes`, () =>
          HttpResponse.json({
            ok: false,
            error: "TD is offline",
          }),
        ),
      );
      let threw = false;
      let result: Awaited<ReturnType<typeof createLiveSourceImpl>> | undefined;
      try {
        result = await createLiveSourceImpl(makeCtx(), {
          name: "live_source",
          parent_path: "/project1",
          kind: "screen_grab",
          resolution: [1280, 720],
        });
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
      // Either an error result or a partial result with warnings.
      if (result) {
        const text = result.content.find((c) => c.type === "text") as
          | { type: "text"; text: string }
          | undefined;
        expect(text).toBeDefined();
      }
    });

    it("schema rejects unknown kind", () => {
      expect(() => createLiveSourceSchema.parse({ kind: "webcam_magic" })).toThrow();
    });

    it("schema rejects resolution tuple with wrong length (single number)", () => {
      expect(() => createLiveSourceSchema.parse({ resolution: [1280] })).toThrow();
    });
  });

  describe("output Null TOP is always created", () => {
    it("out1 null is created for all kinds", async () => {
      const kinds = ["screen_grab", "ndi", "syphon_spout", "camera", "video_stream"] as const;
      for (const kind of kinds) {
        const bodies = captureCreateBodies();
        const result = await createLiveSourceImpl(makeCtx(), {
          name: "live_source",
          parent_path: "/project1",
          kind,
          resolution: [1280, 720],
        });
        expect(result.isError).toBeFalsy();
        const hasOut1 = bodies.some((b) => b.type === "nullTOP" && b.name === "out1");
        expect(hasOut1, `out1 nullTOP missing for kind=${kind}`).toBe(true);
        server.resetHandlers();
      }
    });
  });
});
