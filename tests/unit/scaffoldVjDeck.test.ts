import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { scaffoldVjDeckImpl, scaffoldVjDeckSchema } from "../../src/tools/layer2/scaffoldVjDeck.js";
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

// The decks build creates real nodes (msw default /api/nodes echoes a path). The control
// surface and MIDI-in builds go through /api/exec and parse a JSON report. Answer exec by
// sniffing the decoded payload's shape.
function wireBridge(opts: { surfaceError?: boolean; midiError?: boolean } = {}): {
  midiBindings: Array<{ channel: string; target: string }>;
} {
  const midiBindings: Array<{ channel: string; target: string }> = [];
  server.use(
    http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
      const body = (await request.json()) as { script: string };
      const m = body.script.match(/b64decode\("([^"]+)"\)/);
      const payload = m?.[1]
        ? (JSON.parse(Buffer.from(m[1], "base64").toString("utf8")) as Record<string, unknown>)
        : {};

      // Control-surface build payload has faders/cue_buttons.
      if ("faders" in payload && "cue_buttons" in payload) {
        if (opts.surfaceError) {
          return HttpResponse.json({
            ok: true,
            data: { result: null, stdout: JSON.stringify({ fatal: "surface boom", warnings: [] }) },
          });
        }
        return HttpResponse.json({
          ok: true,
          data: {
            result: null,
            stdout: JSON.stringify({
              comp: payload.comp,
              surface: `${payload.comp}/surface`,
              faders: (payload.faders as unknown[]).map((_f, i) => ({
                slider: `s${i}`,
                param: "p",
              })),
              cue_buttons: [],
              warnings: [],
            }),
          },
        });
      }

      // MIDI-in build payload has kind === "midi_in".
      if (payload.kind === "midi_in") {
        if (opts.midiError) {
          return HttpResponse.json({
            ok: true,
            data: {
              result: null,
              stdout: JSON.stringify({ kind: "midi_in", fatal: "midi boom", warnings: [] }),
            },
          });
        }
        const bound = (payload.bind_to as Array<{ channel: string; target: string }>) ?? [];
        for (const b of bound) midiBindings.push(b);
        return HttpResponse.json({
          ok: true,
          data: {
            result: null,
            stdout: JSON.stringify({
              kind: "midi_in",
              node: `${payload.parent}/midi`,
              type: "midiinCHOP",
              bound: bound.map((b) => ({ channel: b.channel, target: b.target })),
              warnings: [],
            }),
          },
        });
      }

      // Anything else (control-panel exposure inside finalize, layout, etc.) → benign report.
      return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
    }),
  );
  return { midiBindings };
}

describe("scaffold_vj_deck", () => {
  it("composes decks + fader surface + MIDI map into one container", async () => {
    const { midiBindings } = wireBridge();
    const result = await scaffoldVjDeckImpl(makeCtx(), {
      name: "vj_deck",
      parent_path: "/project1",
      crossfade: 0.5,
      midi: true,
      faders: true,
    });
    expect(result.isError).toBeFalsy();

    const text = result.content.find((c) => c.type === "text") as { text: string } | undefined;
    expect(text?.text).toContain("Scaffolded VJ deck");
    expect(text?.text).toContain("MIDI map");

    // Default MIDI map binds three controls; each target is a real 'nodePath.parName'.
    expect(midiBindings.length).toBe(3);
    expect(midiBindings.some((b) => b.channel === "ch1c1" && b.target.endsWith(".cross"))).toBe(
      true,
    );
    expect(midiBindings.some((b) => b.target.endsWith(".brightness1"))).toBe(true);
  });

  it("honors an explicit midi_map", async () => {
    const { midiBindings } = wireBridge();
    const result = await scaffoldVjDeckImpl(makeCtx(), {
      name: "vj_deck",
      parent_path: "/project1",
      crossfade: 0.5,
      midi: true,
      faders: false,
      midi_map: [{ channel: "cc7", control: "crossfader" }],
    });
    expect(result.isError).toBeFalsy();
    expect(midiBindings).toHaveLength(1);
    expect(midiBindings[0]?.channel).toBe("cc7");
    expect(midiBindings[0]?.target).toMatch(/\.cross$/);
  });

  it("skips MIDI + faders when disabled", async () => {
    const { midiBindings } = wireBridge();
    const result = await scaffoldVjDeckImpl(makeCtx(), {
      name: "vj_deck",
      parent_path: "/project1",
      crossfade: 0.5,
      midi: false,
      faders: false,
    });
    expect(result.isError).toBeFalsy();
    expect(midiBindings).toHaveLength(0);
    const text = result.content.find((c) => c.type === "text") as { text: string } | undefined;
    expect(text?.text).not.toContain("MIDI map");
  });

  it("continues (warns) when the surface or MIDI sub-build fails — deck still built", async () => {
    wireBridge({ surfaceError: true, midiError: true });
    const result = await scaffoldVjDeckImpl(makeCtx(), {
      name: "vj_deck",
      parent_path: "/project1",
      crossfade: 0.5,
      midi: true,
      faders: true,
    });
    expect(result.isError).toBeFalsy(); // fail-forward: partial scaffold still returns
    const text = result.content.find((c) => c.type === "text") as { text: string } | undefined;
    expect(text?.text).toContain("warning");
  });

  it("applies schema defaults", () => {
    const parsed = scaffoldVjDeckSchema.parse({});
    expect(parsed.name).toBe("vj_deck");
    expect(parsed.parent_path).toBe("/project1");
    expect(parsed.crossfade).toBe(0.5);
    expect(parsed.midi).toBe(true);
    expect(parsed.faders).toBe(true);
  });

  it("rejects an invalid midi_map control", () => {
    expect(() =>
      scaffoldVjDeckSchema.parse({ midi_map: [{ channel: "c1", control: "nope" }] }),
    ).toThrow();
    expect(() => scaffoldVjDeckSchema.parse({ crossfade: 5 })).toThrow();
  });

  it("returns isError (never throws) when the deck build itself fails", async () => {
    server.use(
      http.post(`${TD_BASE}/api/nodes`, () =>
        HttpResponse.json({ ok: false, error: "offline" }, { status: 502 }),
      ),
    );
    const result = await scaffoldVjDeckImpl(makeCtx(), {
      name: "vj_deck",
      parent_path: "/project1",
      crossfade: 0.5,
      midi: true,
      faders: true,
    });
    expect(result.isError).toBe(true);
  });
});
