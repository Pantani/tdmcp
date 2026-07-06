import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  createInteractionZonesImpl,
  createInteractionZonesSchema,
} from "../../src/tools/layer1/createInteractionZones.js";
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

const DEFAULTS = {
  threshold: 0.05 as number,
  resolution: [640, 360] as [number, number],
  parent_path: "/project1",
  name: "interaction_zones",
};

describe("create_interaction_zones", () => {
  it("builds a motion chain, 2 crop+analyze zones, and a 'zones' Null CHOP", async () => {
    const bodies = captureCreateBodies();
    captureExecScripts();
    const result = await createInteractionZonesImpl(makeCtx(), {
      ...DEFAULTS,
      zones: [
        { name: "left", x: 0, y: 0, w: 0.5, h: 1 },
        { name: "right", x: 0.5, y: 0, w: 0.5, h: 1 },
      ],
    });
    expect(result.isError).toBeFalsy();

    // Motion-energy chain.
    expect(bodies.some((b) => b.type === "monochromeTOP")).toBe(true);
    expect(bodies.some((b) => b.type === "cacheTOP")).toBe(true);
    expect(bodies.some((b) => b.type === "differenceTOP")).toBe(true);

    // One cropTOP + one analyzeTOP per zone (2 zones).
    expect(bodies.filter((b) => b.type === "cropTOP")).toHaveLength(2);
    expect(bodies.filter((b) => b.type === "analyzeTOP")).toHaveLength(2);
    expect(bodies.some((b) => b.type === "scriptCHOP")).toBe(true);

    // The bind point is a nullCHOP named 'zones'.
    const zonesNull = bodies.find((b) => b.type === "nullCHOP" && b.name === "zones");
    expect(zonesNull).toBeDefined();

    // Summary lists the per-zone state channels and offers a bind target.
    const text = result.content.find((c) => c.type === "text") as { text: string } | undefined;
    expect(text?.text).toContain("left_state");
    expect(text?.text).toContain("right_state");
    expect(text?.text).toContain("left_dwell");
    expect(text?.text).toContain("bind_to_channel");

    // No preview image — the output is a CHOP.
    expect(result.content.some((c) => c.type === "image")).toBe(false);
  });

  it("scales the crop/analyze bodies to N when N zones are passed", async () => {
    const bodies = captureCreateBodies();
    captureExecScripts();
    const result = await createInteractionZonesImpl(makeCtx(), {
      ...DEFAULTS,
      zones: [
        { name: "a", x: 0, y: 0, w: 0.33, h: 1 },
        { name: "b", x: 0.33, y: 0, w: 0.34, h: 1 },
        { name: "c", x: 0.67, y: 0, w: 0.33, h: 1 },
      ],
    });
    expect(result.isError).toBeFalsy();
    expect(bodies.filter((b) => b.type === "cropTOP")).toHaveLength(3);
    expect(bodies.filter((b) => b.type === "analyzeTOP")).toHaveLength(3);
    expect(bodies.filter((b) => b.type === "toptoCHOP")).toHaveLength(3);
  });

  it("emits the top-left→bottom-left uv origin mapping in the crop Python", async () => {
    captureCreateBodies();
    const scripts = captureExecScripts();
    await createInteractionZonesImpl(makeCtx(), {
      ...DEFAULTS,
      // y=0, h=1 → cropbottom = 1 - (0 + 1) = 0, croptop = 1 - 0 = 1.
      zones: [{ name: "full", x: 0, y: 0, w: 1, h: 1 }],
    });
    const crop = scripts.find((s) => s.includes("cropbottom"));
    expect(crop).toBeDefined();
    expect(crop).toContain("'cropbottom', 0");
    expect(crop).toContain("'croptop', 1");
  });

  it("schema defaults yield >=1 zone and threshold 0.05", () => {
    const parsed = createInteractionZonesSchema.parse({});
    expect(parsed.zones.length).toBeGreaterThanOrEqual(1);
    expect(parsed.threshold).toBe(0.05);
    expect(parsed.name).toBe("interaction_zones");
    expect(parsed.parent_path).toBe("/project1");
  });

  it("rejects out-of-range zone coordinates and empty zone arrays at the schema boundary", () => {
    expect(() => createInteractionZonesSchema.parse({ zones: [] })).toThrow();
    expect(() =>
      createInteractionZonesSchema.parse({ zones: [{ x: 1.5, y: 0, w: 0.5, h: 1 }] }),
    ).toThrow();
    expect(() => createInteractionZonesSchema.parse({ threshold: 2 })).toThrow();
  });

  it("never throws and returns an isError result when the bridge fails", async () => {
    server.use(
      http.post(`${TD_BASE}/api/nodes`, () =>
        HttpResponse.json({ ok: false, error: "boom" }, { status: 500 }),
      ),
    );
    const result = await createInteractionZonesImpl(makeCtx(), {
      ...DEFAULTS,
      zones: [{ name: "left", x: 0, y: 0, w: 0.5, h: 1 }],
    });
    expect(result.isError).toBe(true);
    const text = result.content.find((c) => c.type === "text") as { text: string } | undefined;
    expect(text?.text).toBeTruthy();
  });
});
