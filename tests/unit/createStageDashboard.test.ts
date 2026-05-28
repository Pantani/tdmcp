import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { z } from "zod";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  buildDashboardScript,
  createStageDashboardImpl,
  createStageDashboardSchema,
} from "../../src/tools/layer2/createStageDashboard.js";
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

/** Parses partial args through the schema (applying defaults), then runs the tool. */
function run(args: z.input<typeof createStageDashboardSchema>) {
  return createStageDashboardImpl(makeCtx(), createStageDashboardSchema.parse(args));
}

interface DashboardPayload {
  comp: string;
  name: string;
  port: number;
  config: {
    comp: string;
    cues: string[];
    faders: Array<{ label: string; par_path: string }>;
    audio: string | null;
    title: string;
  };
  callbacks: string;
}

/** Decodes the base64 payload the generated script embeds, so tests can assert on it. */
function decodePayload(script: string): DashboardPayload {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (b64 === undefined) throw new Error("script did not embed a base64 payload");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
}

/** Captures the script bodies POSTed to /api/exec so we can inspect the generated Python. */
function captureExec(report: object): { scripts: string[] } {
  const scripts: string[] = [];
  server.use(
    http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
      const body = (await request.json()) as { script: string };
      scripts.push(body.script);
      return HttpResponse.json({
        ok: true,
        data: { result: null, stdout: JSON.stringify(report) },
      });
    }),
  );
  return { scripts };
}

describe("create_stage_dashboard", () => {
  it("round-trips the payload (cues, faders, audio, port, name) through the base64 blob", () => {
    const payload = {
      comp: "/project1",
      name: "stage_dashboard",
      port: 9990,
      config: {
        comp: "/project1",
        cues: ["intro", "drop"],
        faders: [{ label: "Intensity", par_path: "/project1/level1/brightness1" }],
        audio: "/project1/audio_null",
        title: "/project1",
      },
      callbacks: "x",
    };
    expect(decodePayload(buildDashboardScript(payload))).toEqual(payload);
  });

  it("builds a Web Server DAT + callbacks Text DAT, activates it, and reports the URL", async () => {
    const cap = captureExec({
      comp: "/project1",
      server: "/project1/stage_dashboard",
      callbacks: "/project1/stage_dashboard_callbacks",
      port: 9990,
      url: "http://10.0.0.5:9990/",
      cues: ["a", "b"],
      faders: [{ label: "Speed", par_path: "/project1/comp1/Speed" }],
      audio_features: null,
      warnings: [],
    });

    const result = await run({
      cues: ["a", "b"],
      faders: [{ label: "Speed", par_path: "/project1/comp1/Speed" }],
    });
    const text = textOf(result);
    expect(result.isError).toBeUndefined();
    expect(text).toContain("Stage dashboard serving 2 cue button(s) + 1 fader(s) + panic");
    expect(text).toContain("http://10.0.0.5:9990/");

    const script = cap.scripts[0] ?? "";
    // The generated Python must build a Web Server DAT fed by a Text DAT of callbacks,
    // then activate the server (mirrors create_phone_remote).
    expect(script).toContain("td.webserverDAT");
    expect(script).toContain("td.textDAT");
    expect(script).toContain("_server.par.callbacks = _cb");
    expect(script).toContain("_server.par.active = True");
    expect(script).toContain('_server.par.port = _p["port"]');
  });

  it("routes all four widgets (cue, fader, panic, /state) from one callback", async () => {
    const cap = captureExec({
      comp: "/project1",
      server: "/project1/stage_dashboard",
      port: 9990,
      url: "http://x:9990/",
      cues: ["warm"],
      faders: [],
      audio_features: "/project1/audio_null",
      warnings: [],
    });

    await run({ cues: ["warm"], audio_features: "/project1/audio_null" });
    const payload = decodePayload(cap.scripts[0] ?? "");
    const cb = payload.callbacks;

    // One onHTTPRequest switches on a `do` field to serve every widget type.
    expect(cb).toContain("def onHTTPRequest");
    expect(cb).toContain('if do == "cue"');
    expect(cb).toContain('elif do == "fader"');
    expect(cb).toContain('elif do == "panic"');
    // The /state branch returns live readout JSON (beat + vu).
    expect(cb).toContain('if path == "/state"');
    expect(cb).toContain('"beat"');
    expect(cb).toContain('"vu"');
    // Cue recall reuses manage_cue's stored cue map + direct par writes.
    expect(cb).toContain('comp.fetch("tdmcp_cues"');
    // Panic toggles the create_panic source-of-truth pars.
    expect(cb).toContain('"Blackout"');
    expect(cb).toContain('"Freeze"');
    // The config (cues/faders/audio) is baked into the callbacks via the __DASH_CFG__ slot,
    // which the build script substitutes before assigning the Text DAT.
    expect(cb).toContain("__DASH_CFG__");
    expect(payload.config.audio).toBe("/project1/audio_null");
  });

  it("substitutes the baked config into the callbacks at build time in the Python pass", async () => {
    const cap = captureExec({
      comp: "/project1",
      server: "/project1/stage_dashboard",
      port: 9990,
      url: "http://x:9990/",
      cues: [],
      faders: [],
      audio_features: null,
      warnings: [],
    });

    await run({ target: "/project1" });
    const script = cap.scripts[0] ?? "";
    // The running server needs no per-request exec: the script bakes the JSON config into
    // the callbacks string in TD before writing the Text DAT.
    expect(script).toContain('_p["callbacks"].replace("__DASH_CFG__", _cfg)');
  });

  it("returns an isError result (without throwing) when the COMP is missing", async () => {
    captureExec({
      comp: "/nope",
      warnings: [],
      fatal: "COMP not found: /nope",
    });

    const result = await run({ target: "/nope" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Could not start stage dashboard");
    expect(textOf(result)).toContain("COMP not found: /nope");
  });

  it("surfaces a Web Server DAT warning while still succeeding", async () => {
    captureExec({
      comp: "/project1",
      server: "/project1/stage_dashboard",
      port: 9990,
      url: "http://x:9990/",
      cues: [],
      faders: [],
      audio_features: null,
      warnings: ["Web Server DAT: port in use"],
    });

    const result = await run({ target: "/project1" });
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("1 warning(s)");
  });

  it("survives cue/fader strings that would break naive quoting (quotes, newlines, unicode)", () => {
    const payload = {
      comp: "/project1",
      name: "stage_dashboard",
      port: 9990,
      config: {
        comp: "/project1",
        cues: ["line1\nline2 'quoted' ★", '}{")'],
        faders: [{ label: "tricky 'x'\n★", par_path: "/p/q/r" }],
        audio: null,
        title: "/project1",
      },
      callbacks: "c",
    };
    expect(decodePayload(buildDashboardScript(payload))).toEqual(payload);
  });
});
