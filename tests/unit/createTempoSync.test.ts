import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { createTempoSyncImpl } from "../../src/tools/layer1/createTempoSync.js";
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

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
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

describe("create_tempo_sync", () => {
  it("builds a Beat CHOP with the sync channels enabled, ending on a Null CHOP (no image)", async () => {
    const bodies = captureCreateBodies();
    const result = await createTempoSyncImpl(makeCtx(), {
      period: 4,
      emit_events: false,
      expose_controls: false,
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();

    const beat = bodies.find((b) => b.name === "beat");
    expect(beat?.type).toBe("beatCHOP");
    // Every useful sync channel turned on (ramp/pulse/count/beat/bar/bpm) at the given period.
    expect(beat?.parameters).toMatchObject({
      period: 4,
      ramp: 1,
      pulse: 1,
      count: 1,
      beat: 1,
      bar: 1,
      bpm: 1,
    });
    expect(bodies.some((b) => b.name === "tempo" && b.type === "nullCHOP")).toBe(true);

    // Output is a CHOP clock — no preview image.
    expect(result.content.some((c) => c.type === "image")).toBe(false);
    expect(textOf(result)).toContain("ramp/pulse/beat/bar/bpm");
  });

  it("adds a beat-event emitter that broadcasts over the bridge when emit_events is on", async () => {
    const bodies = captureCreateBodies();
    const scripts = captureExecScripts();
    await createTempoSyncImpl(makeCtx(), {
      period: 4,
      emit_events: true,
      expose_controls: false,
      parent_path: "/project1",
    });
    const emitter = bodies.find((b) => b.name === "beat_emitter");
    expect(emitter?.type).toBe("chopexecuteDAT");
    // Fires once per beat off the integer `beat` channel.
    expect(emitter?.parameters).toMatchObject({ channel: "beat", valuechange: 1, active: 1 });
    // The callback broadcasts a `beat` event through the bridge's Web Server DAT.
    const emitterText = scripts.find((s) => s.includes("events.broadcast"));
    expect(emitterText).toBeDefined();
    expect(emitterText).toContain("'beat'");
  });

  it("omits the emitter when emit_events is off", async () => {
    const bodies = captureCreateBodies();
    await createTempoSyncImpl(makeCtx(), {
      period: 4,
      emit_events: false,
      expose_controls: false,
      parent_path: "/project1",
    });
    expect(bodies.some((b) => b.name === "beat_emitter")).toBe(false);
  });

  it("exposes a Period knob bound to the Beat CHOP, seeded from the arg", async () => {
    const scripts = captureExecScripts();
    await createTempoSyncImpl(makeCtx(), {
      period: 3,
      emit_events: false,
      expose_controls: true,
      parent_path: "/project1",
    });
    const period = panelControls(scripts).find((c) => c.name === "Period");
    expect(period?.default).toBe(3);
    expect(period?.bind_to?.[0]).toMatch(/beat\.period$/);
  });
});
