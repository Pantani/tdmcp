import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { z } from "zod";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  createHandHologramImpl,
  createHandHologramSchema,
} from "../../src/tools/layer1/createHandHologram.js";
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

function jsonOf(result: CallToolResult): Record<string, unknown> {
  const match = /```json\n([\s\S]*?)\n```/.exec(textOf(result));
  if (!match) throw new Error("missing JSON result block");
  const json = match[1];
  if (!json) throw new Error("empty JSON result block");
  return JSON.parse(json) as Record<string, unknown>;
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
      const script = ((await request.json()) as { script: string }).script;
      scripts.push(script);
      let stdout = '{"ok":true}';
      if (script.includes('_controls = _payload["controls"]')) {
        stdout = JSON.stringify({ created: [], bound: [], warnings: [] });
      } else if (script.includes("HAND_GESTURE_BUS_STATE")) {
        stdout = JSON.stringify({
          container_path: "/project1/hand_hologram/gesture_bus_comp",
          source: "synthetic",
          hand_chop: "/project1/hand_hologram/gesture_bus_comp/synthetic_hands",
          gesture_chop: "/project1/hand_hologram/gesture_bus_comp/gesture",
          gesture_bus: "/project1/hand_hologram/gesture_bus_comp/gesture_bus",
          state_dat: "/project1/hand_hologram/gesture_bus_comp/state_json",
          channels: ["on", "float_x", "float_y", "palm_size", "pinch_power", "audio_level"],
          controls: [],
          warnings: [],
          errors: [],
        });
      }
      return HttpResponse.json({ ok: true, data: { result: null, stdout } });
    }),
  );
  return scripts;
}

function panelControls(
  scripts: string[],
): Array<{ name: string; type?: string; bind_to?: string[] }> {
  const panel = scripts.find((s) => s.includes('_controls = _payload["controls"]'));
  const b64 = /b64decode\("([^"]+)"\)/.exec(panel ?? "")?.[1];
  if (b64 === undefined) return [];
  return (
    JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as {
      controls: Array<{ name: string; type?: string; bind_to?: string[] }>;
    }
  ).controls;
}

function run(args: Partial<z.input<typeof createHandHologramSchema>> = {}) {
  return createHandHologramImpl(makeCtx(), createHandHologramSchema.parse(args));
}

describe("create_hand_hologram", () => {
  it("parses artist-friendly defaults", () => {
    const parsed = createHandHologramSchema.parse({});
    expect(parsed).toMatchObject({
      source: "synthetic",
      preset: "holo_cube",
      audio_mode: "none",
      comp_name: "hand_hologram",
      color: "#54f4ff",
      accent_color: "#b56cff",
      capture_preview: true,
    });
  });

  it("builds a hologram TOP chain driven by the hand gesture bus", async () => {
    const bodies = captureCreateBodies();
    const scripts = captureExecScripts();

    const result = await run({ source: "synthetic" });
    expect(result.isError).toBeFalsy();

    expect(bodies.find((b) => b.name === "hand_hologram")?.type).toBe("baseCOMP");
    expect(bodies.find((b) => b.name === "bg")?.type).toBe("constantTOP");
    expect(bodies.find((b) => b.name === "holo_frag")?.type).toBe("textDAT");
    expect(bodies.find((b) => b.name === "hologram")?.type).toBe("glslTOP");
    expect(bodies.find((b) => b.name === "glow_blur")?.type).toBe("blurTOP");
    expect(bodies.find((b) => b.name === "glow_level")?.type).toBe("levelTOP");
    expect(bodies.find((b) => b.name === "glow_comp")?.type).toBe("compositeTOP");
    expect(bodies.find((b) => b.name === "out1")?.type).toBe("nullTOP");

    expect(scripts.some((s) => s.includes("HAND_GESTURE_BUS_STATE"))).toBe(true);
    const driver = scripts.find((s) => s.includes("HOLOGRAM_DRIVER"));
    expect(driver).toContain("/project1/hand_hologram/gesture_bus_comp/gesture_bus");
    expect(driver).toContain("float_x");
    expect(driver).toContain("float_y");
    expect(driver).toContain("palm_size");
    expect(driver).toContain("pinch_power");
    expect(driver).toContain("audio_level");
    expect(driver).not.toContain("screen_x");
    expect(driver).not.toContain("state_json");

    const shaderScript = driver ?? "";
    expect(shaderScript).toContain("float visibility = clamp(uOn, 0.0, 1.0);");
    expect(shaderScript).toContain("* visibility;");

    const data = jsonOf(result);
    expect(data).toMatchObject({
      output_path: "/project1/hand_hologram/out1",
      gesture_bus_path: "/project1/hand_hologram/gesture_bus_comp/gesture_bus",
      preset: "holo_cube",
      audio_mode: "none",
    });
    expect(result.content.some((c) => c.type === "image")).toBe(true);
  });

  it("exposes controls for look, motion, pinch scale, and audio mode", async () => {
    const scripts = captureExecScripts();
    const result = await run({ expose_controls: true });
    expect(result.isError).toBeFalsy();

    const controls = panelControls(scripts);
    expect(controls.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        "Size",
        "FloatHeight",
        "Transparency",
        "Glow",
        "Scanline",
        "RotationSpeed",
        "PinchScale",
        "AudioLevel",
      ]),
    );
  });

  it("creates optional synth audio without forcing a device output", async () => {
    const bodies = captureCreateBodies();
    const scripts = captureExecScripts();
    const result = await run({ audio_mode: "synth" });
    expect(result.isError).toBeFalsy();

    expect(bodies.filter((b) => b.type === "audiooscillatorCHOP")).toHaveLength(2);
    expect(bodies.find((b) => b.name === "audio_drone")?.parameters).toMatchObject({
      frequency: 90,
    });
    expect(bodies.find((b) => b.name === "audio_shimmer")?.parameters).toMatchObject({
      frequency: 430,
    });
    expect(bodies.some((b) => b.type === "mergeCHOP")).toBe(true);
    expect(bodies.some((b) => b.type === "audiodeviceoutCHOP")).toBe(false);
    expect(scripts.find((s) => s.includes("HOLOGRAM_DRIVER"))).toContain(".par.frequency.expr");
    expect(jsonOf(result)).toMatchObject({ audio_mode: "synth" });
  });

  it("creates device output only when requested and embeds the device hint", async () => {
    const bodies = captureCreateBodies();
    const scripts = captureExecScripts();
    const result = await run({ audio_mode: "device_out", audio_device_hint: "UMC202HD" });
    expect(result.isError).toBeFalsy();

    expect(bodies.some((b) => b.type === "audiodeviceoutCHOP")).toBe(true);
    expect(scripts.find((s) => s.includes("HOLOGRAM_DRIVER"))).toContain("UMC202HD");
    expect(jsonOf(result)).toMatchObject({ audio_mode: "device_out" });
  });
});
