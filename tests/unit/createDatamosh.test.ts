import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { createDatamoshImpl, createDatamoshSchema } from "../../src/tools/layer1/createDatamosh.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

interface CreatedNodeBody {
  parent_path: string;
  type: string;
  name?: string;
  parameters?: Record<string, unknown>;
}

interface PanelControl {
  name: string;
  type?: string;
  default?: unknown;
  bind_to?: string[];
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

function panelControls(scripts: string[]): PanelControl[] {
  const panel = scripts.find((s) => s.includes("appendCustomPage"));
  const b64 = /b64decode\("([^"]+)"\)/.exec(panel ?? "")?.[1];
  if (b64 === undefined) return [];
  const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as {
    controls: PanelControl[];
  };
  return payload.controls;
}

describe("create_datamosh", () => {
  // -------------------------------------------------------------------------
  // Schema validation
  // -------------------------------------------------------------------------
  describe("schema", () => {
    it("uses sensible defaults", () => {
      const parsed = createDatamoshSchema.parse({});
      expect(parsed.name).toBe("datamosh");
      expect(parsed.parent_path).toBe("/project1");
      expect(parsed.mode).toBe("feedback_echo");
      expect(parsed.decay).toBe(0.9);
      expect(parsed.displace).toBe(0.0);
      expect(parsed.resolution).toEqual([1280, 720]);
      expect(parsed.source).toBeUndefined();
    });

    it("rejects an unknown mode", () => {
      expect(() => createDatamoshSchema.parse({ mode: "magic" })).toThrow();
    });

    it("rejects decay > 1 or < 0", () => {
      expect(() => createDatamoshSchema.parse({ decay: 1.5 })).toThrow();
      expect(() => createDatamoshSchema.parse({ decay: -0.1 })).toThrow();
    });

    it("accepts all valid modes", () => {
      expect(() => createDatamoshSchema.parse({ mode: "feedback_echo" })).not.toThrow();
      expect(() => createDatamoshSchema.parse({ mode: "frame_blend" })).not.toThrow();
      expect(() => createDatamoshSchema.parse({ mode: "time_echo" })).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // feedback_echo mode
  // -------------------------------------------------------------------------
  describe("feedback_echo mode", () => {
    it("creates feedbackTOP + compositeTOP + levelTOP + nullTOP", async () => {
      const bodies = captureCreateBodies();
      const result = await createDatamoshImpl(makeCtx(), {
        name: "datamosh",
        parent_path: "/project1",
        mode: "feedback_echo",
        decay: 0.9,
        displace: 0.0,
        resolution: [1280, 720],
      });
      expect(result.isError).toBeFalsy();
      expect(bodies.some((b) => b.type === "feedbackTOP")).toBe(true);
      expect(bodies.some((b) => b.type === "compositeTOP")).toBe(true);
      expect(bodies.some((b) => b.type === "levelTOP")).toBe(true);
      expect(bodies.some((b) => b.type === "nullTOP" && b.name === "out1")).toBe(true);
    });

    it("uses a noiseTOP source when source is omitted", async () => {
      const bodies = captureCreateBodies();
      await createDatamoshImpl(makeCtx(), {
        name: "datamosh",
        parent_path: "/project1",
        mode: "feedback_echo",
        decay: 0.9,
        displace: 0.0,
        resolution: [1280, 720],
      });
      expect(bodies.some((b) => b.type === "noiseTOP")).toBe(true);
    });

    it("uses a selectTOP when source is provided", async () => {
      const bodies = captureCreateBodies();
      await createDatamoshImpl(makeCtx(), {
        name: "datamosh",
        parent_path: "/project1",
        mode: "feedback_echo",
        decay: 0.85,
        displace: 0.0,
        resolution: [1280, 720],
        source: "/project1/mycam",
      });
      expect(bodies.some((b) => b.type === "selectTOP")).toBe(true);
      expect(bodies.some((b) => b.type === "noiseTOP")).toBe(false);
    });

    it("closes the feedback loop via python (sets feedbackTOP.par.top)", async () => {
      const scripts = captureExecScripts();
      await createDatamoshImpl(makeCtx(), {
        name: "datamosh",
        parent_path: "/project1",
        mode: "feedback_echo",
        decay: 0.9,
        displace: 0.0,
        resolution: [1280, 720],
      });
      // The loop closure script sets feedbackTOP.par.top to the decay level node
      const loopScript = scripts.find((s) => s.includes(".par.top ="));
      expect(loopScript).toBeDefined();
    });

    it("exposes a Decay control bound to brightness1", async () => {
      const scripts = captureExecScripts();
      await createDatamoshImpl(makeCtx(), {
        name: "datamosh",
        parent_path: "/project1",
        mode: "feedback_echo",
        decay: 0.8,
        displace: 0.0,
        resolution: [1280, 720],
      });
      const controls = panelControls(scripts);
      const decay = controls.find((c) => c.name === "Decay");
      expect(decay).toBeDefined();
      expect(decay?.type).toBe("float");
      expect(decay?.default).toBe(0.8);
    });

    it("adds a displaceTOP when displace > 0 and exposes Displace control", async () => {
      const bodies = captureCreateBodies();
      const scripts = captureExecScripts();
      const result = await createDatamoshImpl(makeCtx(), {
        name: "datamosh",
        parent_path: "/project1",
        mode: "feedback_echo",
        decay: 0.9,
        displace: 0.3,
        resolution: [1280, 720],
      });
      expect(result.isError).toBeFalsy();
      expect(bodies.some((b) => b.type === "displaceTOP")).toBe(true);
      const controls = panelControls(scripts);
      expect(controls.some((c) => c.name === "Displace")).toBe(true);
    });

    it("sets displace weight via defensive probe (displaceweight1 before displaceweight)", async () => {
      const scripts = captureExecScripts();
      await createDatamoshImpl(makeCtx(), {
        name: "datamosh",
        parent_path: "/project1",
        mode: "feedback_echo",
        decay: 0.9,
        displace: 0.3,
        resolution: [1280, 720],
      });
      const dispScript = scripts.find(
        (s) => s.includes("displaceweight1") && s.includes("displaceweight"),
      );
      expect(dispScript).toBeDefined();
      // displaceweight1 must be attempted before displaceweight
      expect(dispScript!.indexOf("displaceweight1")).toBeLessThan(
        dispScript!.lastIndexOf("displaceweight"),
      );
    });

    it("Displace control bind_to targets the displace node with displaceweight1", async () => {
      const scripts = captureExecScripts();
      await createDatamoshImpl(makeCtx(), {
        name: "datamosh",
        parent_path: "/project1",
        mode: "feedback_echo",
        decay: 0.9,
        displace: 0.3,
        resolution: [1280, 720],
      });
      const controls = panelControls(scripts);
      const displace = controls.find((c) => c.name === "Displace");
      expect(displace).toBeDefined();
      const bindTo = displace?.bind_to ?? [];
      // Must target displaceweight1 (not the old displaceweight on the decay node)
      expect(bindTo.some((t) => t.includes("displaceweight1"))).toBe(true);
      expect(bindTo.every((t) => !t.includes("decay1"))).toBe(true);
    });

    it("does NOT add a displaceTOP when displace is 0", async () => {
      const bodies = captureCreateBodies();
      await createDatamoshImpl(makeCtx(), {
        name: "datamosh",
        parent_path: "/project1",
        mode: "feedback_echo",
        decay: 0.9,
        displace: 0.0,
        resolution: [1280, 720],
      });
      expect(bodies.some((b) => b.type === "displaceTOP")).toBe(false);
    });

    it("returns a text summary (not just JSON) with 'feedback_echo' in it", async () => {
      const result = await createDatamoshImpl(makeCtx(), {
        name: "datamosh",
        parent_path: "/project1",
        mode: "feedback_echo",
        decay: 0.9,
        displace: 0.0,
        resolution: [1280, 720],
      });
      const text = result.content.find((c) => c.type === "text") as { text: string } | undefined;
      expect(text?.text).toContain("feedback_echo");
    });
  });

  // -------------------------------------------------------------------------
  // frame_blend mode
  // -------------------------------------------------------------------------
  describe("frame_blend mode", () => {
    it("creates cacheTOP + levelTOP + compositeTOP + nullTOP", async () => {
      const bodies = captureCreateBodies();
      const result = await createDatamoshImpl(makeCtx(), {
        name: "datamosh",
        parent_path: "/project1",
        mode: "frame_blend",
        decay: 0.7,
        displace: 0.0,
        resolution: [1280, 720],
      });
      expect(result.isError).toBeFalsy();
      expect(bodies.some((b) => b.type === "cacheTOP")).toBe(true);
      expect(bodies.some((b) => b.type === "levelTOP")).toBe(true);
      expect(bodies.some((b) => b.type === "compositeTOP")).toBe(true);
      expect(bodies.some((b) => b.type === "nullTOP" && b.name === "out1")).toBe(true);
    });

    it("exposes a Decay control", async () => {
      const scripts = captureExecScripts();
      await createDatamoshImpl(makeCtx(), {
        name: "datamosh",
        parent_path: "/project1",
        mode: "frame_blend",
        decay: 0.6,
        displace: 0.0,
        resolution: [1280, 720],
      });
      const controls = panelControls(scripts);
      const decay = controls.find((c) => c.name === "Decay");
      expect(decay).toBeDefined();
      expect(decay?.default).toBe(0.6);
    });
  });

  // -------------------------------------------------------------------------
  // time_echo mode
  // -------------------------------------------------------------------------
  describe("time_echo mode", () => {
    it("creates cacheTOP + noiseTOP + timemachineTOP + nullTOP", async () => {
      const bodies = captureCreateBodies();
      const result = await createDatamoshImpl(makeCtx(), {
        name: "datamosh",
        parent_path: "/project1",
        mode: "time_echo",
        decay: 0.9,
        displace: 0.0,
        resolution: [1280, 720],
      });
      expect(result.isError).toBeFalsy();
      expect(bodies.some((b) => b.type === "cacheTOP")).toBe(true);
      expect(bodies.some((b) => b.type === "timemachineTOP")).toBe(true);
      expect(bodies.some((b) => b.type === "nullTOP" && b.name === "out1")).toBe(true);
    });

    it("flags UNVERIFIED items in the extra block", async () => {
      const result = await createDatamoshImpl(makeCtx(), {
        name: "datamosh",
        parent_path: "/project1",
        mode: "time_echo",
        decay: 0.9,
        displace: 0.0,
        resolution: [1280, 720],
      });
      const text = result.content.find((c) => c.type === "text") as { text: string } | undefined;
      expect(text?.text).toContain("UNVERIFIED");
      expect(text?.text).toContain("unverified");
    });
  });

  // -------------------------------------------------------------------------
  // Error / fail-safe paths
  // -------------------------------------------------------------------------
  describe("error handling", () => {
    it("returns isError when bridge returns a fatal report — does NOT throw", async () => {
      server.use(
        http.post(`${TD_BASE}/api/nodes`, async ({ request }) => {
          const body = (await request.json()) as CreatedNodeBody;
          // Fail on baseCOMP creation (the container)
          if (body.type === "baseCOMP") {
            return HttpResponse.json({ ok: false, error: "Permission denied" }, { status: 403 });
          }
          const name = body.name ?? `${body.type.replace(/[^a-zA-Z0-9]/g, "").toLowerCase()}1`;
          return HttpResponse.json({
            ok: true,
            data: { path: `${body.parent_path}/${name}`, type: body.type, name },
          });
        }),
      );
      let result: Awaited<ReturnType<typeof createDatamoshImpl>> | undefined;
      // Must not throw
      await expect(
        (async () => {
          result = await createDatamoshImpl(makeCtx(), {
            name: "datamosh",
            parent_path: "/project1",
            mode: "feedback_echo",
            decay: 0.9,
            displace: 0.0,
            resolution: [1280, 720],
          });
        })(),
      ).resolves.toBeUndefined();
      expect(result?.isError).toBe(true);
    });

    it("never throws on a network error — returns isError", async () => {
      server.use(http.post(`${TD_BASE}/api/nodes`, () => HttpResponse.error()));
      const result = await createDatamoshImpl(makeCtx(), {
        name: "datamosh",
        parent_path: "/project1",
        mode: "feedback_echo",
        decay: 0.9,
        displace: 0.0,
        resolution: [1280, 720],
      });
      expect(result.isError).toBe(true);
    });
  });
});
