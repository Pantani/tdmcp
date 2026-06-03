import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  createAudioReactiveImpl,
  createAudioReactiveSchema,
} from "../../src/tools/layer1/createAudioReactive.js";
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

const BASE_ARGS = {
  audio_source: "microphone" as const,
  visual_style: "glsl" as const,
  frequency_bands: 8,
  beat_detection: false,
  expose_controls: true,
  parent_path: "/project1",
  transient_gate: false,
  transient_threshold: 0.3,
  transient_hold_ms: 120,
  sidechain_duck: false,
  duck_depth: 0.7,
  duck_release_ms: 350,
};

describe("createAudioReactiveImpl — sidechain + transient extension", () => {
  it("backward-compat: defaults produce no transient/duck/merge/mod1 nodes", async () => {
    const bodies = captureCreateBodies();
    const scripts = captureExecScripts();
    await createAudioReactiveImpl(makeCtx(), {
      ...BASE_ARGS,
      expose_controls: true,
    });
    expect(bodies.some((b) => b.type === "filterCHOP")).toBe(false);
    expect(bodies.some((b) => b.type === "mathCHOP")).toBe(false);
    expect(bodies.some((b) => b.type === "mergeCHOP")).toBe(false);
    expect(bodies.some((b) => b.type === "nullCHOP" && b.name === "mod1")).toBe(false);
    const controls = panelControls(scripts);
    expect(controls.map((c) => c.name)).toEqual(["Sensitivity"]);
  });

  it("transient_gate=true: adds transient analyze + filter + merge + mod1 Null", async () => {
    const bodies = captureCreateBodies();
    const scripts = captureExecScripts();
    await createAudioReactiveImpl(makeCtx(), {
      ...BASE_ARGS,
      transient_gate: true,
    });
    expect(bodies.some((b) => b.name === "transient" && b.type === "analyzeCHOP")).toBe(true);
    expect(bodies.some((b) => b.name === "transient_hold" && b.type === "filterCHOP")).toBe(true);
    expect(bodies.some((b) => b.type === "mergeCHOP")).toBe(true);
    expect(bodies.some((b) => b.name === "mod1" && b.type === "nullCHOP")).toBe(true);
    const controls = panelControls(scripts);
    expect(controls.some((c) => c.name === "Transient Threshold")).toBe(true);
    expect(controls.some((c) => c.name === "Transient Hold (samples)")).toBe(true);
  });

  it("sidechain_duck=true: adds duck filter + math + mod1 Null with Duck controls", async () => {
    const bodies = captureCreateBodies();
    const scripts = captureExecScripts();
    await createAudioReactiveImpl(makeCtx(), {
      ...BASE_ARGS,
      sidechain_duck: true,
    });
    expect(bodies.some((b) => b.name === "duck_env" && b.type === "filterCHOP")).toBe(true);
    expect(bodies.some((b) => b.name === "duck" && b.type === "mathCHOP")).toBe(true);
    expect(bodies.some((b) => b.name === "mod1" && b.type === "nullCHOP")).toBe(true);
    const controls = panelControls(scripts);
    expect(controls.some((c) => c.name === "Duck Depth")).toBe(true);
    expect(controls.some((c) => c.name === "Duck Release (samples)")).toBe(true);
  });

  it("both flags on: mod1 is the final CHOP Null and out1 TOP path remains", async () => {
    const bodies = captureCreateBodies();
    await createAudioReactiveImpl(makeCtx(), {
      ...BASE_ARGS,
      transient_gate: true,
      sidechain_duck: true,
    });
    expect(bodies.some((b) => b.name === "mod1" && b.type === "nullCHOP")).toBe(true);
    expect(bodies.some((b) => b.name === "out1" && b.type === "nullTOP")).toBe(true);
  });

  it("Zod rejects out-of-range thresholds and negative ms", () => {
    expect(
      createAudioReactiveSchema.safeParse({
        visual_style: "glsl",
        transient_threshold: 1.5,
      }).success,
    ).toBe(false);
    expect(
      createAudioReactiveSchema.safeParse({
        visual_style: "glsl",
        duck_depth: -0.1,
      }).success,
    ).toBe(false);
    expect(
      createAudioReactiveSchema.safeParse({
        visual_style: "glsl",
        transient_hold_ms: -10,
      }).success,
    ).toBe(false);
  });
});

// Silence unused-import warnings under strict noUnusedLocals if applicable.
void textOf;
function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}
