import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  createSetNavigatorImpl,
  createSetNavigatorSchema,
} from "../../src/tools/layer1/createSetNavigator.js";
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

/**
 * Intercepts /api/exec. The nav-setup pass (detectable by containing "tdmcp_nav_target")
 * gets a populated NavSetupReport so parsePythonReport succeeds. All other passes return
 * empty stdout (layout, error-check, panel — those paths handle empty stdout gracefully).
 */
function captureExecScripts(
  navScenes = ["intro", "verse", "chorus"],
  targetPath = "/project1/show_comp",
): string[] {
  const scripts: string[] = [];
  server.use(
    http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
      const body = (await request.json()) as { script: string };
      scripts.push(body.script);
      if (body.script.includes("tdmcp_nav_target")) {
        const report = {
          container: "/project1/set_navigator",
          target: targetPath,
          navigator: "/project1/set_navigator",
          scene_table: "/project1/set_navigator/scenes",
          engine: "/project1/set_navigator/nav_engine",
          scenes: navScenes,
          go_on_beat: false,
          warnings: [],
        };
        return HttpResponse.json({
          ok: true,
          data: { result: null, stdout: JSON.stringify(report) },
        });
      }
      return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
    }),
  );
  return scripts;
}

/** Decode the base64 payload embedded in a script string. */
function decodePayload(script: string): Record<string, unknown> | undefined {
  const match = /b64decode\("([^"]+)"\)/.exec(script);
  if (!match?.[1]) return undefined;
  try {
    return JSON.parse(Buffer.from(match[1], "base64").toString("utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * Find the finalize control-panel script and extract controls from its payload.
 * The panel script is the one whose decoded payload has a "controls" array key
 * (as opposed to the nav-setup script whose payload has "container"/"target").
 */
function panelControls(scripts: string[]): PanelControl[] {
  for (const s of scripts) {
    const payload = decodePayload(s);
    if (!payload || !Array.isArray(payload.controls)) continue;
    return payload.controls as PanelControl[];
  }
  return [];
}

// All args with defaulted fields spelled out explicitly (required for tsc).
const BASE_ARGS = {
  name: "set_navigator",
  parent_path: "/project1",
  target: "/project1/show_comp",
  scenes: ["intro", "verse", "chorus"],
  go_on_beat: false,
  resolution: [1280, 720] as [number, number],
};

describe("create_set_navigator", () => {
  it("creates a baseCOMP container with the navigator name", async () => {
    const bodies = captureCreateBodies();
    captureExecScripts();
    const result = await createSetNavigatorImpl(makeCtx(), BASE_ARGS);
    expect(result.isError).toBeFalsy();
    const container = bodies.find((b) => b.type === "baseCOMP" && b.name === "set_navigator");
    expect(container).toBeDefined();
    expect(container?.parent_path).toBe("/project1");
  });

  it("sends the NAV_SETUP_SCRIPT with the correct payload fields", async () => {
    captureCreateBodies();
    const scripts = captureExecScripts();
    await createSetNavigatorImpl(makeCtx(), BASE_ARGS);

    const setupScript = scripts.find((s) => s.includes("tdmcp_nav_target"));
    expect(setupScript).toBeDefined();

    const payload = decodePayload(setupScript ?? "");
    expect(payload).toBeDefined();
    expect(payload?.target).toBe("/project1/show_comp");
    expect(payload?.scenes).toEqual(["intro", "verse", "chorus"]);
    expect(payload?.go_on_beat).toBe(false);
  });

  it("populates the payload with provided scenes list", async () => {
    captureCreateBodies();
    const scenes = ["scene_a", "scene_b", "scene_c", "scene_d"];
    const scripts = captureExecScripts(scenes);
    await createSetNavigatorImpl(makeCtx(), { ...BASE_ARGS, scenes });
    const setupScript = scripts.find((s) => s.includes("tdmcp_nav_target"));
    const payload = decodePayload(setupScript ?? "");
    expect(payload?.scenes).toEqual(scenes);
  });

  it("exposes Index, Next, Prev, Go controls via the finalize control panel", async () => {
    captureCreateBodies();
    const scripts = captureExecScripts();
    await createSetNavigatorImpl(makeCtx(), BASE_ARGS);
    const controls = panelControls(scripts);
    // panelControls extracts the 'controls' array from the finalize panel payload.
    expect(controls.find((c) => c.name === "Index")).toBeDefined();
    expect(controls.find((c) => c.name === "Next")).toBeDefined();
    expect(controls.find((c) => c.name === "Prev")).toBeDefined();
    expect(controls.find((c) => c.name === "Go")).toBeDefined();
  });

  it("Index control defaults to 0 and is of type int", async () => {
    captureCreateBodies();
    const scripts = captureExecScripts();
    await createSetNavigatorImpl(makeCtx(), BASE_ARGS);
    const controls = panelControls(scripts);
    const index = controls.find((c) => c.name === "Index");
    expect(index?.type).toBe("int");
    expect(index?.default).toBe(0);
  });

  it("Next, Prev, Go controls are of type pulse", async () => {
    captureCreateBodies();
    const scripts = captureExecScripts();
    await createSetNavigatorImpl(makeCtx(), BASE_ARGS);
    const controls = panelControls(scripts);
    expect(controls.find((c) => c.name === "Next")?.type).toBe("pulse");
    expect(controls.find((c) => c.name === "Prev")?.type).toBe("pulse");
    expect(controls.find((c) => c.name === "Go")?.type).toBe("pulse");
  });

  it("includes go_on_beat=true in payload when requested", async () => {
    captureCreateBodies();
    const scripts = captureExecScripts(BASE_ARGS.scenes);
    await createSetNavigatorImpl(makeCtx(), { ...BASE_ARGS, go_on_beat: true });
    const setupScript = scripts.find((s) => s.includes("tdmcp_nav_target"));
    const payload = decodePayload(setupScript ?? "");
    expect(payload?.go_on_beat).toBe(true);
  });

  it("summary mentions the target COMP", async () => {
    captureCreateBodies();
    captureExecScripts();
    const result = await createSetNavigatorImpl(makeCtx(), BASE_ARGS);
    const text = result.content.find((c) => c.type === "text") as { text: string } | undefined;
    expect(text?.text).toContain("/project1/show_comp");
  });

  it("summary mentions UNVERIFIED for offline builds", async () => {
    captureCreateBodies();
    captureExecScripts();
    const result = await createSetNavigatorImpl(makeCtx(), BASE_ARGS);
    const text = result.content.find((c) => c.type === "text") as { text: string } | undefined;
    expect(text?.text).toContain("UNVERIFIED");
  });

  it("does not produce an image (non-visual tool)", async () => {
    captureCreateBodies();
    captureExecScripts();
    const result = await createSetNavigatorImpl(makeCtx(), BASE_ARGS);
    expect(result.content.some((c) => c.type === "image")).toBe(false);
  });

  it("returns isError when bridge exec returns a fatal report — does not throw", async () => {
    captureCreateBodies();
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        HttpResponse.json({
          ok: true,
          data: {
            result: null,
            stdout: JSON.stringify({
              container: "/project1/set_navigator",
              target: "/project1/show_comp",
              scenes: [],
              go_on_beat: false,
              warnings: [],
              fatal: "COMP not found: /project1/show_comp",
            }),
          },
        }),
      ),
    );
    const result = await createSetNavigatorImpl(makeCtx(), BASE_ARGS);
    expect(result.isError).toBe(true);
  });

  it("target field is required — schema rejects a missing target", () => {
    expect(() => createSetNavigatorSchema.parse({ scenes: [] })).toThrow();
  });

  it("schema applies defaults for name, parent_path, scenes, go_on_beat, resolution", () => {
    const parsed = createSetNavigatorSchema.parse({ target: "/project1/ctrl" });
    expect(parsed.name).toBe("set_navigator");
    expect(parsed.parent_path).toBe("/project1");
    expect(parsed.scenes).toEqual([]);
    expect(parsed.go_on_beat).toBe(false);
    expect(parsed.resolution).toEqual([1280, 720]);
  });

  it("empty scenes list is valid (navigator reads from target at runtime)", () => {
    const parsed = createSetNavigatorSchema.parse({
      target: "/project1/ctrl",
      scenes: [],
    });
    expect(parsed.scenes).toEqual([]);
  });

  it("handles bridge connection error gracefully — does not throw", async () => {
    server.use(
      http.post(`${TD_BASE}/api/nodes`, () => HttpResponse.error()),
      http.post(`${TD_BASE}/api/exec`, () => HttpResponse.error()),
    );
    const result = await createSetNavigatorImpl(makeCtx(), BASE_ARGS);
    expect(result.isError).toBe(true);
  });
});
