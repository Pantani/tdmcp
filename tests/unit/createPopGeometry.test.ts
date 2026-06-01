import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { createPopGeometryImpl } from "../../src/tools/layer1/createPopGeometry.js";
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

const DEFAULTS = {
  primitive: "box" as const,
  translate: [0, 0, 0] as [number, number, number],
  rotate: [0, 0, 0] as [number, number, number],
  scale: [1, 1, 1] as [number, number, number],
  subdivisions: 0,
  noise_amount: 0,
  noise_period: 1,
  text_string: "tdmcp",
  expose_controls: false,
  parent_path: "/project1",
};

describe("create_pop_geometry", () => {
  it("builds primitive → transform → mat → null SOP chain + render rig (defaults)", async () => {
    const bodies = captureCreateBodies();
    const result = await createPopGeometryImpl(makeCtx(), { ...DEFAULTS });
    expect(result.isError).toBeFalsy();
    expect(bodies.find((b) => b.name === "geo")?.type).toBe("geometryCOMP");
    expect(bodies.find((b) => b.name === "prim")?.type).toBe("boxSOP");
    expect(bodies.find((b) => b.name === "xform")?.type).toBe("transformSOP");
    expect(bodies.find((b) => b.name === "mat")?.type).toBe("constantMAT");
    expect(bodies.find((b) => b.name === "matSop")?.type).toBe("materialSOP");
    expect(bodies.find((b) => b.name === "out_sop")?.type).toBe("nullSOP");
    expect(bodies.find((b) => b.name === "render")?.type).toBe("renderTOP");
    expect(bodies.find((b) => b.name === "out1")?.type).toBe("nullTOP");
    // No subdiv / noise without opts
    expect(bodies.some((b) => b.type === "subdivideSOP")).toBe(false);
    expect(bodies.some((b) => b.type === "noiseSOP")).toBe(false);
  });

  it("maps transform params to tx/ty/tz/rx/ry/rz/sx/sy/sz", async () => {
    const bodies = captureCreateBodies();
    await createPopGeometryImpl(makeCtx(), {
      ...DEFAULTS,
      translate: [1, 2, 3],
      rotate: [10, 20, 30],
      scale: [2, 0.5, 1],
    });
    expect(bodies.find((b) => b.name === "xform")?.parameters).toMatchObject({
      tx: 1,
      ty: 2,
      tz: 3,
      rx: 10,
      ry: 20,
      rz: 30,
      sx: 2,
      sy: 0.5,
      sz: 1,
    });
  });

  it("adds Subdivide + Noise SOPs when subdivisions and noise are set", async () => {
    const bodies = captureCreateBodies();
    await createPopGeometryImpl(makeCtx(), {
      ...DEFAULTS,
      subdivisions: 2,
      noise_amount: 0.5,
      noise_period: 1.5,
    });
    const sub = bodies.find((b) => b.name === "subdiv");
    expect(sub?.type).toBe("subdivideSOP");
    expect(sub?.parameters).toMatchObject({ depth: 2 });
    const noise = bodies.find((b) => b.name === "displace");
    expect(noise?.type).toBe("noiseSOP");
    expect(noise?.parameters).toMatchObject({ amp: 0.5, period: 1.5 });
  });

  it("uses textSOP with text_string when primitive=text", async () => {
    const bodies = captureCreateBodies();
    await createPopGeometryImpl(makeCtx(), {
      ...DEFAULTS,
      primitive: "text",
      text_string: "hello",
    });
    const prim = bodies.find((b) => b.name === "prim");
    expect(prim?.type).toBe("textSOP");
    expect(prim?.parameters).toMatchObject({ text: "hello" });
  });

  it("exposes RotateY/NoiseAmount/NoisePeriod when expose_controls=true with noise>0", async () => {
    const scripts: string[] = [];
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        scripts.push(((await request.json()) as { script: string }).script);
        return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
      }),
    );
    await createPopGeometryImpl(makeCtx(), {
      ...DEFAULTS,
      expose_controls: true,
      noise_amount: 0.4,
    });
    const panel = scripts.find((s) => s.includes("appendCustomPage"));
    expect(panel).toBeDefined();
    const b64 = /b64decode\("([^"]+)"\)/.exec(panel ?? "")?.[1];
    if (b64 === undefined) throw new Error("panel script did not embed a base64 payload");
    const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as {
      controls: Array<{ name: string; bind_to?: string[] }>;
    };
    const names = payload.controls.map((c) => c.name);
    expect(names).toContain("RotateY");
    expect(names).toContain("NoiseAmount");
    expect(names).toContain("NoisePeriod");
    // The Noise* controls must be bound to the displace SOP (not inert).
    const noiseAmt = payload.controls.find((c) => c.name === "NoiseAmount");
    expect(noiseAmt?.bind_to?.[0]).toMatch(/\/displace\.amp$/);
  });

  it("omits NoiseAmount/NoisePeriod when expose_controls=true but noise_amount=0", async () => {
    const scripts: string[] = [];
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        scripts.push(((await request.json()) as { script: string }).script);
        return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
      }),
    );
    await createPopGeometryImpl(makeCtx(), {
      ...DEFAULTS,
      expose_controls: true,
      // noise_amount stays 0 — no Noise SOP in chain, so Noise* controls would
      // be inert and must be omitted.
    });
    const panel = scripts.find((s) => s.includes("appendCustomPage"));
    expect(panel).toBeDefined();
    const b64 = /b64decode\("([^"]+)"\)/.exec(panel ?? "")?.[1];
    if (b64 === undefined) throw new Error("panel script did not embed a base64 payload");
    const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as {
      controls: Array<{ name: string }>;
    };
    const names = payload.controls.map((c) => c.name);
    expect(names).toContain("RotateY");
    expect(names).not.toContain("NoiseAmount");
    expect(names).not.toContain("NoisePeriod");
  });
});
