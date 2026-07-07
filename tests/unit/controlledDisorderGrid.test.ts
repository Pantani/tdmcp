import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  controlledDisorderGridImpl,
  controlledDisorderGridSchema,
} from "../../src/tools/layer1/controlledDisorderGrid.js";
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

const DEFAULT_ARGS = {
  rows: 20,
  cols: 20,
  disorder: 0.35,
  pos_jitter: 0.5,
  rot_jitter: 1.2,
  scale_jitter: 0.3,
  fill: 0.7,
  outline: false,
  line_width: 0.04,
  cell_color: "#f2f2f2",
  background: "#101014",
  resolution: [1080, 1080] as [number, number],
  expose_controls: true,
  parent_path: "/project1",
};

describe("controlled_disorder_grid", () => {
  it("builds a single glslTOP → null out chain", async () => {
    const bodies = captureCreateBodies();
    captureExecScripts();
    const result = await controlledDisorderGridImpl(makeCtx(), { ...DEFAULT_ARGS });
    expect(result.isError).toBeFalsy();

    expect(bodies.some((b) => b.type === "glslTOP" && b.name === "grid")).toBe(true);
    expect(bodies.some((b) => b.type === "nullTOP" && b.name === "out1")).toBe(true);
  });

  it("writes uGrid/uDisorder uniforms and the Disorder expr into the exec scripts", async () => {
    captureCreateBodies();
    const scripts = captureExecScripts();
    await controlledDisorderGridImpl(makeCtx(), { ...DEFAULT_ARGS, rows: 12, cols: 8 });

    const uniformScript = scripts.find((s) => s.includes("vec0valuex ="));
    expect(uniformScript).toBeDefined();
    expect(uniformScript).toContain("uGrid");
    expect(uniformScript).toContain("vec0valuex = 8"); // cols
    expect(uniformScript).toContain("vec0valuey = 12"); // rows
    expect(uniformScript).toContain("Disorder");

    const fragScript = scripts.find((s) => s.includes("sdBox") && s.includes("uDisorder"));
    expect(fragScript).toBeDefined();
  });

  it("exposes defaults and validates ranges at the schema boundary", () => {
    const parsed = controlledDisorderGridSchema.parse({});
    expect(parsed.rows).toBe(20);
    expect(parsed.disorder).toBe(0.35);
    expect(parsed.outline).toBe(false);
    expect(() => controlledDisorderGridSchema.parse({ disorder: 2 })).toThrow();
    expect(() => controlledDisorderGridSchema.parse({ rows: 0 })).toThrow();
    expect(() => controlledDisorderGridSchema.parse({ fill: 0 })).toThrow();
  });

  it("never throws and returns an isError result when node creation fails (bridge fatal)", async () => {
    server.use(
      http.post(`${TD_BASE}/api/nodes`, () =>
        HttpResponse.json({ ok: false, error: "TouchDesigner is offline" }, { status: 502 }),
      ),
    );
    const result = await controlledDisorderGridImpl(makeCtx(), { ...DEFAULT_ARGS });
    expect(result.isError).toBe(true);
  });
});
