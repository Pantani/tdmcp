import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  createMidiNoteReactiveImpl,
  createMidiNoteReactiveSchema,
} from "../../src/tools/layer1/createMidiNoteReactive.js";
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

describe("create_midi_note_reactive", () => {
  // -----------------------------------------------------------------------
  // Synthetic path: the default validatable path
  // -----------------------------------------------------------------------

  it("synthetic path: creates a Noise CHOP source, Limit CHOP, Event CHOP, and Null CHOP", async () => {
    const bodies = captureCreateBodies();
    captureExecScripts();

    const result = await createMidiNoteReactiveImpl(makeCtx(), {
      name: "midi_note_reactive",
      parent_path: "/project1",
      source: "synthetic",
      notes: 12,
    });

    expect(result.isError).toBeFalsy();

    // Container COMP
    const container = bodies.find((b) => b.type === "baseCOMP");
    expect(container).toBeDefined();
    expect(container?.name).toBe("midi_note_reactive");

    // Synthetic source chain
    expect(bodies.some((b) => b.type === "noiseCHOP" && b.name === "note_source")).toBe(true);
    expect(bodies.some((b) => b.type === "limitCHOP" && b.name === "note_trigger")).toBe(true);
    expect(bodies.some((b) => b.type === "eventCHOP" && b.name === "events")).toBe(true);
    expect(bodies.some((b) => b.type === "nullCHOP" && b.name === "notes_out")).toBe(true);

    // No MIDI hardware node in synthetic mode
    expect(bodies.some((b) => b.type === "midiinCHOP")).toBe(false);
  });

  it("synthetic path: keep-alive DAT is created so the chain cooks without timeline", async () => {
    const bodies = captureCreateBodies();
    captureExecScripts();

    await createMidiNoteReactiveImpl(makeCtx(), {
      name: "midi_note_reactive",
      parent_path: "/project1",
      source: "synthetic",
      notes: 12,
    });

    expect(bodies.some((b) => b.type === "executeDAT" && b.name === "keepalive")).toBe(true);
  });

  it("synthetic path: setup scripts configure note count and ADSR envelope", async () => {
    captureCreateBodies();
    const scripts = captureExecScripts();

    await createMidiNoteReactiveImpl(makeCtx(), {
      name: "midi_note_reactive",
      parent_path: "/project1",
      source: "synthetic",
      notes: 12,
    });

    // The noise setup script should configure chancount and channel names
    const noiseScript = scripts.find((s) => s.includes("chancount"));
    expect(noiseScript).toBeDefined();
    expect(noiseScript).toContain("12");

    // Event CHOP should be configured with attack/release
    const adsrScript = scripts.find((s) => s.includes("attacktime") || s.includes("releasetime"));
    expect(adsrScript).toBeDefined();
    expect(adsrScript).toContain("attacktime");
    expect(adsrScript).toContain("releasetime");

    // Keep-alive should enable framestart
    const keepAliveScript = scripts.find((s) => s.includes("framestart"));
    expect(keepAliveScript).toBeDefined();
    expect(keepAliveScript).toContain("framestart");
  });

  it("synthetic path: summary text is descriptive and includes channel bind advice", async () => {
    captureCreateBodies();
    captureExecScripts();

    const result = await createMidiNoteReactiveImpl(makeCtx(), {
      name: "midi_note_reactive",
      parent_path: "/project1",
      source: "synthetic",
      notes: 12,
    });

    const textBlock = result.content.find((c) => c.type === "text") as { text: string } | undefined;
    expect(textBlock?.text).toContain("synthetic");
    expect(textBlock?.text).toContain("notes_out");
    expect(textBlock?.text).toContain("note0");
  });

  it("synthetic path: no preview image (CHOP output, not TOP)", async () => {
    captureCreateBodies();
    captureExecScripts();

    const result = await createMidiNoteReactiveImpl(makeCtx(), {
      name: "midi_note_reactive",
      parent_path: "/project1",
      source: "synthetic",
      notes: 12,
    });

    expect(result.content.some((c) => c.type === "image")).toBe(false);
  });

  it("synthetic path with custom note count: sets up the correct channel count", async () => {
    captureCreateBodies();
    const scripts = captureExecScripts();

    await createMidiNoteReactiveImpl(makeCtx(), {
      name: "midi_note_reactive",
      parent_path: "/project1",
      source: "synthetic",
      notes: 24,
    });

    const noiseScript = scripts.find((s) => s.includes("chancount"));
    expect(noiseScript).toContain("24");
  });

  // -----------------------------------------------------------------------
  // Device path: hardware-gated, creates midiinCHOP
  // -----------------------------------------------------------------------

  it("device path: creates a midiinCHOP and eventCHOP, not a Noise CHOP", async () => {
    const bodies = captureCreateBodies();
    captureExecScripts();

    const result = await createMidiNoteReactiveImpl(makeCtx(), {
      name: "midi_note_reactive",
      parent_path: "/project1",
      source: "device",
      notes: 12,
    });

    // Device path should not throw
    expect(result.isError).toBeFalsy();

    expect(bodies.some((b) => b.type === "midiinCHOP" && b.name === "midiin")).toBe(true);
    expect(bodies.some((b) => b.type === "eventCHOP" && b.name === "events")).toBe(true);
    expect(bodies.some((b) => b.type === "nullCHOP" && b.name === "notes_out")).toBe(true);

    // No synthetic noise source in device mode
    expect(bodies.some((b) => b.type === "noiseCHOP")).toBe(false);
    expect(bodies.some((b) => b.type === "limitCHOP")).toBe(false);
  });

  it("device path: keeps-alive DAT is also created", async () => {
    const bodies = captureCreateBodies();
    captureExecScripts();

    await createMidiNoteReactiveImpl(makeCtx(), {
      name: "midi_note_reactive",
      parent_path: "/project1",
      source: "device",
      notes: 12,
    });

    expect(bodies.some((b) => b.type === "executeDAT" && b.name === "keepalive")).toBe(true);
  });

  it("device path with device_name: passes the device name into the setup script", async () => {
    captureCreateBodies();
    const scripts = captureExecScripts();

    await createMidiNoteReactiveImpl(makeCtx(), {
      name: "midi_note_reactive",
      parent_path: "/project1",
      source: "device",
      device_name: "Arturia MiniLab",
      notes: 12,
    });

    const deviceScript = scripts.find((s) => s.includes("Arturia MiniLab"));
    expect(deviceScript).toBeDefined();
  });

  it("device path: summary and result contain HARDWARE-GATED caveat", async () => {
    captureCreateBodies();
    captureExecScripts();

    const result = await createMidiNoteReactiveImpl(makeCtx(), {
      name: "midi_note_reactive",
      parent_path: "/project1",
      source: "device",
      notes: 12,
    });

    const textBlock = result.content.find((c) => c.type === "text") as { text: string } | undefined;
    // Summary mentions hardware requirement
    expect(textBlock?.text).toContain("HARDWARE-GATED");
  });

  // -----------------------------------------------------------------------
  // Schema validation
  // -----------------------------------------------------------------------

  it("schema: defaults source to synthetic, name to 'midi_note_reactive', notes to 12", () => {
    const parsed = createMidiNoteReactiveSchema.parse({});
    expect(parsed.source).toBe("synthetic");
    expect(parsed.name).toBe("midi_note_reactive");
    expect(parsed.notes).toBe(12);
    expect(parsed.parent_path).toBe("/project1");
  });

  it("schema: rejects notes below 1 and above 128", () => {
    expect(() => createMidiNoteReactiveSchema.parse({ notes: 0 })).toThrow();
    expect(() => createMidiNoteReactiveSchema.parse({ notes: 129 })).toThrow();
  });

  it("schema: rejects an unknown source value", () => {
    expect(() => createMidiNoteReactiveSchema.parse({ source: "ableton" })).toThrow();
  });

  // -----------------------------------------------------------------------
  // Fatal bridge error: result is isError, never throws
  // -----------------------------------------------------------------------

  it("bridge fatal on container creation: returns isError result, does not throw", async () => {
    server.use(
      http.post(`${TD_BASE}/api/nodes`, async () => {
        return HttpResponse.json(
          { ok: false, error: { code: "TD_ERROR", message: "Node creation failed" } },
          { status: 500 },
        );
      }),
    );

    // runBuild catches TdErrors and converts them to errorResult
    const result = await createMidiNoteReactiveImpl(makeCtx(), {
      name: "midi_note_reactive",
      parent_path: "/project1",
      source: "synthetic",
      notes: 12,
    });

    expect(result.isError).toBe(true);
    // Should never throw — errorResult returns a text content block with isError
    expect(result.content.length).toBeGreaterThan(0);
  });

  it("exec script failure: build still returns a result (fail-forward), never throws", async () => {
    // Nodes succeed but exec fails — builder collects as warnings, not a throw
    server.use(
      http.post(`${TD_BASE}/api/exec`, async () => {
        return HttpResponse.json(
          { ok: false, error: { code: "TD_ERROR", message: "Script error" } },
          { status: 500 },
        );
      }),
    );

    let threw = false;
    let result: Awaited<ReturnType<typeof createMidiNoteReactiveImpl>> | undefined;
    try {
      result = await createMidiNoteReactiveImpl(makeCtx(), {
        name: "midi_note_reactive",
        parent_path: "/project1",
        source: "synthetic",
        notes: 12,
      });
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    // Result should still exist (partial build is better than nothing)
    expect(result).toBeDefined();
  });
});
