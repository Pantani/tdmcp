import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  createSyncExternalClockImpl,
  createSyncExternalClockSchema,
} from "../../src/tools/layer1/createSyncExternalClock.js";
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

describe("sync_external_clock", () => {
  // Stable surface: tap mode is fully offline-deterministic — the engine, the
  // panel controls, and the schema clamps all run without any external hardware.
  describe("stable — mode='tap' (offline-deterministic)", () => {
    it("builds a Parameter Execute engine and writes the global tempo (no image)", async () => {
      const bodies = captureCreateBodies();
      const scripts = captureExecScripts();
      const result = await createSyncExternalClockImpl(makeCtx(), {
        bpm: 120,
        mode: "tap",
        parent_path: "/project1",
      });
      expect(result.isError).toBeFalsy();

      const engine = bodies.find((b) => b.name === "engine");
      expect(engine?.type).toBe("parameterexecuteDAT");

      // The engine watches its own custom params and pushes the starting tempo to the global clock.
      const setup = scripts.find((s) => s.includes("time.tempo"));
      expect(setup).toBeDefined();
      expect(setup).toContain("op('/').time.tempo = 120");
      expect(setup).toContain("_e.par.onpulse = True");
      expect(setup).toContain("_e.par.valuechange = True");
      // The deployed callback handles both the Bpm knob and the Tap pulse.
      expect(setup).toContain("def onValueChange");
      expect(setup).toContain("def onPulse");

      // It drives the global clock, so there is no visual output.
      expect(result.content.some((c) => c.type === "image")).toBe(false);
    });

    it("exposes a Bpm knob (seeded from the arg) and a Tap pulse", async () => {
      const scripts = captureExecScripts();
      await createSyncExternalClockImpl(makeCtx(), {
        bpm: 140,
        mode: "tap",
        parent_path: "/project1",
      });
      const controls = panelControls(scripts);
      const bpm = controls.find((c) => c.name === "Bpm");
      expect(bpm?.type).toBe("float");
      expect(bpm?.default).toBe(140);
      expect(controls.find((c) => c.name === "Tap")?.type).toBe("pulse");
    });

    it("writes the custom starting tempo into the setup script", async () => {
      const scripts = captureExecScripts();
      await createSyncExternalClockImpl(makeCtx(), {
        bpm: 140,
        mode: "tap",
        parent_path: "/project1",
      });
      expect(scripts.some((s) => s.includes("op('/').time.tempo = 140"))).toBe(true);
    });

    it("clamps BPM to a musical 40–220 range at the schema boundary", () => {
      expect(() => createSyncExternalClockSchema.parse({ bpm: 300 })).toThrow();
      expect(() => createSyncExternalClockSchema.parse({ bpm: 10 })).toThrow();
      // Default is a sensible 120 when omitted.
      expect(createSyncExternalClockSchema.parse({}).bpm).toBe(120);
    });

    it("defaults to tap mode and rejects an unknown mode", () => {
      expect(createSyncExternalClockSchema.parse({}).mode).toBe("tap");
      expect(() => createSyncExternalClockSchema.parse({ mode: "wishful" })).toThrow();
    });

    it("tap mode (default) does not create Link/MIDI nodes", async () => {
      const bodies = captureCreateBodies();
      captureExecScripts();
      await createSyncExternalClockImpl(makeCtx(), {
        bpm: 120,
        mode: "tap",
        parent_path: "/project1",
      });
      expect(bodies.some((b) => b.type === "abletonlinkCHOP")).toBe(false);
      expect(bodies.some((b) => b.type === "midiinDAT")).toBe(false);
    });
  });

  // Hardware-gated: this describe validates network construction offline
  // (operator types, callback wiring, schema acceptance). Live behavior
  // requires an active Ableton Link session on the LAN and is not asserted here.
  describe("hardware-gated — mode='ableton_link' (offline schema + topology only)", () => {
    it("ableton_link mode adds an Ableton Link CHOP + CHOP Execute that drives the global tempo", async () => {
      const bodies = captureCreateBodies();
      const scripts = captureExecScripts();
      const result = await createSyncExternalClockImpl(makeCtx(), {
        bpm: 128,
        mode: "ableton_link",
        parent_path: "/project1",
      });
      expect(result.isError).toBeFalsy();
      expect(bodies.some((b) => b.type === "abletonlinkCHOP")).toBe(true);
      expect(bodies.some((b) => b.type === "chopexecuteDAT")).toBe(true);
      // The CHOP Execute forwards the link tempo channel to the global clock.
      const cb = scripts.find((s) => s.includes("def onValueChange(channel"));
      expect(cb).toBeDefined();
      expect(cb).toContain("channel.name == 'tempo'");
      expect(cb).toContain("op('/').time.tempo");
      // The result flags that Link can't be confirmed without a live session.
      const text = result.content.find((c) => c.type === "text") as { text: string } | undefined;
      expect(text?.text).toContain("Ableton Link");
    });
  });

  // Hardware-gated: validates that the MIDI In DAT + callbacks DAT are wired
  // and the onReceiveMIDI body derives BPM from incoming Clock messages.
  // Live behavior requires a physical MIDI clock source and is not asserted here.
  describe("hardware-gated — mode='midi_clock' (offline schema + topology only)", () => {
    it("midi_clock mode adds a MIDI In DAT + callbacks DAT that derives BPM from clock", async () => {
      const bodies = captureCreateBodies();
      const scripts = captureExecScripts();
      const result = await createSyncExternalClockImpl(makeCtx(), {
        bpm: 120,
        mode: "midi_clock",
        parent_path: "/project1",
      });
      expect(result.isError).toBeFalsy();
      expect(bodies.some((b) => b.type === "midiinDAT")).toBe(true);
      expect(bodies.some((b) => b.type === "textDAT" && b.name === "midiclock")).toBe(true);
      const cb = scripts.find((s) => s.includes("def onReceiveMIDI"));
      expect(cb).toBeDefined();
      expect(cb).toContain("message != 'Clock'");
      expect(cb).toContain("op('/').time.tempo");
    });
  });
});
