import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  buildMidiMapScript,
  createMidiMapImpl,
  createMidiMapSchema,
  DEVICE_PRESETS,
} from "../../src/tools/layer2/createMidiMap.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

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

interface MidiMapPayload {
  parent: string;
  name: string;
  device: string;
  presets: Array<{ id: string; type: string; number: number; channel: number }>;
  target: string | null;
  bindings: Array<{ control: string; target_param?: string; cue?: string }>;
}

function decodePayload(script: string): MidiMapPayload {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (b64 === undefined) throw new Error("script did not embed a base64 payload");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as MidiMapPayload;
}

function mockExec(report: object, capture?: (script: string) => void) {
  server.use(
    http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
      const script = ((await request.json()) as { script: string }).script;
      capture?.(script);
      return HttpResponse.json({
        ok: true,
        data: { result: null, stdout: JSON.stringify(report) },
      });
    }),
  );
}

// ---------------------------------------------------------------------------
// buildMidiMapScript (pure)
// ---------------------------------------------------------------------------

describe("buildMidiMapScript", () => {
  it("round-trips the payload through the embedded base64 blob", () => {
    const preset = DEVICE_PRESETS.nanokontrol ?? [];
    const payload: MidiMapPayload = {
      parent: "/project1",
      name: "midi_map",
      device: "nanokontrol",
      presets: preset,
      target: null,
      bindings: [],
    };
    expect(decodePayload(buildMidiMapScript(payload))).toEqual(payload);
  });

  it("embeds the midiinCHOP creation and TableDAT machinery", () => {
    const script = buildMidiMapScript({
      parent: "/project1",
      name: "midi_map",
      device: "nanokontrol",
      presets: DEVICE_PRESETS.nanokontrol ?? [],
      target: null,
      bindings: [],
    });
    expect(script).toContain("midiinCHOP");
    expect(script).toContain("tableDAT");
    expect(script).toContain("_tbl.appendRow");
    // Bind expression mirrors bind_to_channel / learn_control pattern
    expect(script).toContain("_PM = type(_par.mode)");
    expect(script).toContain("_par.mode = _PM.EXPRESSION");
    // Report always carries the unverified list
    expect(script).toContain('"unverified"');
    expect(script).toContain("hardware");
  });

  it("uses the correct base64 transport (no user-string interpolation)", () => {
    const tricky = {
      parent: '/project1/a"b',
      name: 'midi"map',
      device: "generic",
      presets: [],
      target: null,
      bindings: [{ control: "fader1", target_param: '/project1/n.par"A' }],
    };
    // Should not throw and should round-trip cleanly
    const script = buildMidiMapScript(tricky);
    expect(decodePayload(script)).toEqual(tricky);
  });
});

// ---------------------------------------------------------------------------
// DEVICE_PRESETS shape
// ---------------------------------------------------------------------------

describe("DEVICE_PRESETS", () => {
  it("has entries for all five supported device keys", () => {
    expect(DEVICE_PRESETS).toHaveProperty("apc_mini");
    expect(DEVICE_PRESETS).toHaveProperty("launchpad");
    expect(DEVICE_PRESETS).toHaveProperty("midi_mix");
    expect(DEVICE_PRESETS).toHaveProperty("nanokontrol");
    expect(DEVICE_PRESETS).toHaveProperty("generic");
  });

  it("generic device has no preset entries (bare scaffold)", () => {
    expect((DEVICE_PRESETS.generic ?? []).length).toBe(0);
  });

  it("nanokontrol preset includes faders, knobs, and transport buttons", () => {
    const preset = DEVICE_PRESETS.nanokontrol ?? [];
    const ids = preset.map((e) => e.id);
    expect(ids).toContain("fader1");
    expect(ids).toContain("fader8");
    expect(ids).toContain("knob1");
    expect(ids).toContain("knob8");
    expect(ids).toContain("transport_play");
    expect(ids).toContain("transport_stop");
  });

  it("apc_mini preset includes both faders and pads", () => {
    const preset = DEVICE_PRESETS.apc_mini ?? [];
    const ids = preset.map((e) => e.id);
    expect(ids).toContain("fader1");
    expect(ids).toContain("master_fader");
    expect(ids).toContain("pad0");
    expect(ids).toContain("pad7");
  });

  it("midi_mix preset includes faders, knobs, and mute buttons", () => {
    const preset = DEVICE_PRESETS.midi_mix ?? [];
    const ids = preset.map((e) => e.id);
    expect(ids).toContain("fader1");
    expect(ids).toContain("knob1");
    expect(ids).toContain("mute1");
  });

  it("launchpad preset includes pads and scene buttons", () => {
    const preset = DEVICE_PRESETS.launchpad ?? [];
    const ids = preset.map((e) => e.id);
    expect(ids).toContain("pad0");
    expect(ids).toContain("scene0");
    expect(ids).toContain("scene7");
  });

  it("every non-generic preset entry has id, type, number, and channel", () => {
    for (const [device, entries] of Object.entries(DEVICE_PRESETS)) {
      if (device === "generic") continue;
      for (const e of entries) {
        expect(e.id, `${device}[${e.id}].id`).toBeTypeOf("string");
        expect(["cc", "note"], `${device}[${e.id}].type`).toContain(e.type);
        expect(e.number, `${device}[${e.id}].number`).toBeTypeOf("number");
        expect(e.channel, `${device}[${e.id}].channel`).toBeTypeOf("number");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// createMidiMapSchema defaults
// ---------------------------------------------------------------------------

describe("createMidiMapSchema defaults", () => {
  it("defaults device to nanokontrol", () => {
    const parsed = createMidiMapSchema.parse({});
    expect(parsed.device).toBe("nanokontrol");
  });

  it("defaults parent_path to /project1", () => {
    const parsed = createMidiMapSchema.parse({});
    expect(parsed.parent_path).toBe("/project1");
  });

  it("defaults name to midi_map", () => {
    const parsed = createMidiMapSchema.parse({});
    expect(parsed.name).toBe("midi_map");
  });

  it("defaults bindings to empty array", () => {
    const parsed = createMidiMapSchema.parse({});
    expect(parsed.bindings).toEqual([]);
  });

  it("rejects an unknown device enum value", () => {
    expect(() => createMidiMapSchema.parse({ device: "launchpad_x_pro" })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// createMidiMapImpl — happy path
// ---------------------------------------------------------------------------

describe("createMidiMapImpl — happy path", () => {
  it("passes the correct device and preset to the bridge and returns a summary", async () => {
    let capturedScript = "";
    mockExec(
      {
        device: "nanokontrol",
        midi_in: "/project1/midi_map",
        bind_table: "/project1/midi_map_binds",
        bound: [
          { control: "fader1", cc_or_note: "ch1_cc0" },
          { control: "fader2", cc_or_note: "ch1_cc1" },
        ],
        warnings: [],
        unverified: [
          "CC/note channel numbers per device are best-effort — validate with hardware.",
        ],
      },
      (s) => {
        capturedScript = s;
      },
    );

    const result = await createMidiMapImpl(makeCtx(), {
      parent_path: "/project1",
      name: "midi_map",
      device: "nanokontrol",
      bindings: [],
    });

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("nanokontrol");
    expect(text).toContain("hardware-UNVERIFIED");
    expect(text).toContain("2 binding(s)");

    // Verify payload sent to bridge
    const payload = decodePayload(capturedScript);
    expect(payload.device).toBe("nanokontrol");
    expect(payload.parent).toBe("/project1");
    expect(payload.name).toBe("midi_map");
    expect(payload.target).toBeNull();
    expect(payload.bindings).toEqual([]);
    // Preset entries were embedded (nanokontrol has fader1 at CC0)
    const fader1 = payload.presets.find((e) => e.id === "fader1");
    expect(fader1).toBeDefined();
    expect(fader1?.type).toBe("cc");
    expect(fader1?.number).toBe(0);
  });

  it("forwards explicit bindings overrides in the payload", async () => {
    let capturedScript = "";
    mockExec(
      {
        device: "apc_mini",
        midi_in: "/project1/apc_map",
        bind_table: "/project1/apc_map_binds",
        bound: [
          {
            control: "fader1",
            cc_or_note: "ch1_cc48",
            target_param: "/project1/comp1.Level",
          },
        ],
        warnings: [],
        unverified: ["CC/note channel numbers per device are best-effort."],
      },
      (s) => {
        capturedScript = s;
      },
    );

    const result = await createMidiMapImpl(makeCtx(), {
      parent_path: "/project1",
      name: "apc_map",
      device: "apc_mini",
      bindings: [{ control: "fader1", target_param: "/project1/comp1.Level" }],
    });

    expect(result.isError).toBeFalsy();
    const payload = decodePayload(capturedScript);
    expect(payload.device).toBe("apc_mini");
    expect(payload.bindings).toEqual([
      { control: "fader1", target_param: "/project1/comp1.Level" },
    ]);
    // apc_mini fader1 should be CC 48
    const fader1 = payload.presets.find((e) => e.id === "fader1");
    expect(fader1?.number).toBe(48);
  });

  it("passes target comp path for auto-binding", async () => {
    let capturedScript = "";
    mockExec(
      {
        device: "nanokontrol",
        midi_in: "/project1/midi_map",
        bind_table: "/project1/midi_map_binds",
        bound: [{ control: "fader1", cc_or_note: "ch1_cc0", target_param: "/project1/vis.Gain" }],
        warnings: [],
        unverified: [],
      },
      (s) => {
        capturedScript = s;
      },
    );

    await createMidiMapImpl(makeCtx(), {
      parent_path: "/project1",
      name: "midi_map",
      device: "nanokontrol",
      target: "/project1/vis",
      bindings: [],
    });

    const payload = decodePayload(capturedScript);
    expect(payload.target).toBe("/project1/vis");
  });

  it("generic device sends empty presets array", async () => {
    let capturedScript = "";
    mockExec(
      {
        device: "generic",
        midi_in: "/project1/midi_map",
        bind_table: "/project1/midi_map_binds",
        bound: [],
        warnings: [],
        unverified: [],
      },
      (s) => {
        capturedScript = s;
      },
    );

    await createMidiMapImpl(makeCtx(), {
      parent_path: "/project1",
      name: "midi_map",
      device: "generic",
      bindings: [],
    });

    const payload = decodePayload(capturedScript);
    expect(payload.presets).toEqual([]);
    expect(payload.device).toBe("generic");
  });

  it("includes warnings from the bridge in the summary text", async () => {
    mockExec({
      device: "nanokontrol",
      midi_in: "/project1/midi_map",
      bind_table: "/project1/midi_map_binds",
      bound: [{ control: "fader1", cc_or_note: "ch1_cc0" }],
      warnings: ["No parameter 'norm' on midiinCHOP (skipped)"],
      unverified: [],
    });

    const result = await createMidiMapImpl(makeCtx(), {
      parent_path: "/project1",
      name: "midi_map",
      device: "nanokontrol",
      bindings: [],
    });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("1 warning(s)");
  });
});

// ---------------------------------------------------------------------------
// createMidiMapImpl — fatal path (returns isError, never throws)
// ---------------------------------------------------------------------------

describe("createMidiMapImpl — fatal (bridge error)", () => {
  it("returns isError when the parent COMP is not found — does not throw", async () => {
    mockExec({
      device: "nanokontrol",
      midi_in: null,
      bind_table: null,
      bound: [],
      warnings: [],
      unverified: [],
      fatal: "Parent COMP not found: /project1/does_not_exist",
    });

    const result = await createMidiMapImpl(makeCtx(), {
      parent_path: "/project1/does_not_exist",
      name: "midi_map",
      device: "nanokontrol",
      bindings: [],
    });

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("Parent COMP not found");
    expect(text).toContain("/project1/does_not_exist");
  });

  it("returns isError when midiinCHOP creation fails — does not throw", async () => {
    mockExec({
      device: "apc_mini",
      midi_in: null,
      bind_table: null,
      bound: [],
      warnings: [],
      unverified: [],
      fatal: "Could not create midiinCHOP: name collision",
    });

    const result = await createMidiMapImpl(makeCtx(), {
      parent_path: "/project1",
      name: "midi_map",
      device: "apc_mini",
      bindings: [],
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Could not create midiinCHOP");
  });

  it("handles a bridge connection error without throwing", async () => {
    // Override exec to simulate TD being unreachable
    server.use(http.post(`${TD_BASE}/api/exec`, () => HttpResponse.error()));

    const result = await createMidiMapImpl(makeCtx(), {
      parent_path: "/project1",
      name: "midi_map",
      device: "nanokontrol",
      bindings: [],
    });

    expect(result.isError).toBe(true);
    // Must never throw — guardTd converts TdConnectionError to isError
    const text = textOf(result);
    expect(text.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// createMidiMapImpl — no-throw guarantee for bad bridge output
// ---------------------------------------------------------------------------

describe("createMidiMapImpl — no-throw on malformed bridge output", () => {
  it("returns isError when stdout is empty (parsePythonReport throws) — does not throw out of impl", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        HttpResponse.json({ ok: true, data: { result: null, stdout: "" } }),
      ),
    );

    // guardTd catches the TdApiError thrown by parsePythonReport
    const result = await createMidiMapImpl(makeCtx(), {
      parent_path: "/project1",
      name: "midi_map",
      device: "nanokontrol",
      bindings: [],
    });

    expect(result.isError).toBe(true);
  });
});
