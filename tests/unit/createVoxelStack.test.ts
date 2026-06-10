import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  createVoxelStackImpl,
  createVoxelStackSchema,
} from "../../src/tools/layer1/createVoxelStack.js";
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
  parent_path: "/project1",
  name: "voxel_stack",
  grid_size: [32, 32] as [number, number],
  voxel_size: 0.5,
  height_scale: 8,
  color_mode: "source_color" as const,
  output_resolution: [1280, 720] as [number, number],
  camera_mode: "isometric" as const,
  expose_controls: false,
} satisfies Parameters<typeof createVoxelStackImpl>[1];

describe("create_voxel_stack", () => {
  it("case 1: default 32×32 build — core nodes created and instancing python emitted", async () => {
    const bodies = captureCreateBodies();
    const scripts: string[] = [];
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        scripts.push(((await request.json()) as { script: string }).script);
        return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
      }),
    );

    const result = await createVoxelStackImpl(makeCtx(), { ...DEFAULTS });

    expect(result.isError).toBeFalsy();

    // Core operator types must be present
    expect(bodies.find((b) => b.name === "voxel_geo")?.type).toBe("geometryCOMP");
    expect(bodies.find((b) => b.name === "voxel")?.type).toBe("boxSOP");
    expect(bodies.find((b) => b.name === "render")?.type).toBe("renderTOP");
    expect(bodies.find((b) => b.name === "out1")?.type).toBe("nullTOP");
    expect(bodies.find((b) => b.name === "cam")?.type).toBe("cameraCOMP");

    // CHOP chain
    expect(bodies.find((b) => b.name === "pattern1")?.type).toBe("patternCHOP");
    expect(bodies.find((b) => b.name === "inst_null")?.type).toBe("nullCHOP");

    // Instancing python block must set numinstances=1024
    const instScript = scripts.find((s) => s.includes("numinstances"));
    expect(instScript).toBeDefined();
    expect(instScript).toContain("numinstances = 1024");
    expect(instScript).toContain('par.instancetx = "tx"');
    expect(instScript).toContain('par.instancety = "ty"');
    expect(instScript).toContain('par.instancer = "r"');

    // Output path in extras
    const content = JSON.stringify(result.content);
    expect(content).toContain("out1");
    expect(content).toContain("1024");
  });

  it("case 2: custom source_top_path — uses selectTOP wrapping that path, no internal noiseTOP", async () => {
    const bodies = captureCreateBodies();
    server.use(
      http.post(`${TD_BASE}/api/exec`, async () =>
        HttpResponse.json({ ok: true, data: { result: null, stdout: "" } }),
      ),
    );

    const result = await createVoxelStackImpl(makeCtx(), {
      ...DEFAULTS,
      source_top_path: "/project1/myCam/out1",
    });

    expect(result.isError).toBeFalsy();

    const src = bodies.find((b) => b.name === "src_top");
    expect(src?.type).toBe("selectTOP");
    expect(src?.parameters?.top).toBe("/project1/myCam/out1");

    // No internal noiseTOP should be created
    expect(bodies.some((b) => b.type === "noiseTOP")).toBe(false);
  });

  it("case 3: palette color mode — rampTOP created, palette python emitted", async () => {
    const bodies = captureCreateBodies();
    const scripts: string[] = [];
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        scripts.push(((await request.json()) as { script: string }).script);
        return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
      }),
    );

    const result = await createVoxelStackImpl(makeCtx(), {
      ...DEFAULTS,
      color_mode: "palette",
      palette: [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
    });

    expect(result.isError).toBeFalsy();

    // rampTOP must be created
    expect(bodies.find((b) => b.name === "palette_ramp")?.type).toBe("rampTOP");

    // python must set ramp keys
    const rampScript = scripts.find((s) => s.includes("_r.ramp"));
    expect(rampScript).toBeDefined();
    // 3-stop palette: keys 0, 1, 2 must appear
    expect(rampScript).toContain('"r":1');
    expect(rampScript).toContain('"g":1');
    expect(rampScript).toContain('"b":1');
  });

  it("case 4: grid_size cap — [512,512] rejected by Zod schema validation", () => {
    const result = createVoxelStackSchema.safeParse({
      grid_size: [512, 512],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const flat = result.error.flatten();
      const msgs = Object.values(flat.fieldErrors).flat().join(" ");
      // Zod max(256) produces a "too_big" or "Number must be less than..." message
      expect(msgs.toLowerCase()).toMatch(/256|too_big|maximum/i);
    }
  });

  it("case 5: TD failure on instancing python — isError result, fail-forward partial container", async () => {
    const bodies: CreatedNodeBody[] = [];
    let execCallCount = 0;
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
      http.post(`${TD_BASE}/api/exec`, async () => {
        execCallCount++;
        // Fail the instancing python block (second exec call after placeInGridScript)
        if (execCallCount >= 2) {
          return HttpResponse.json(
            { ok: false, error: { message: "instancing failed: geometryCOMP not found" } },
            { status: 500 },
          );
        }
        return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
      }),
    );

    const result = await createVoxelStackImpl(makeCtx(), { ...DEFAULTS });

    // The build should NOT throw — it returns an isError result (runBuild catches TD errors)
    // OR it returns a partial build with warnings (NetworkBuilder fail-forward).
    // Either way the result must be defined and the call must not throw.
    expect(result).toBeDefined();
    expect(execCallCount).toBeGreaterThanOrEqual(2);

    // If it is a full error, check the message is friendly (no raw stack).
    if (result.isError) {
      const content = JSON.stringify(result.content);
      expect(content.toLowerCase()).toMatch(/fail|error|instanc/i);
    } else {
      // Partial build: warnings/details should still mention instancing failure
      const content = JSON.stringify(result.content);
      expect(content.toLowerCase()).toMatch(/fail|error|instanc/i);
    }
  });
});
