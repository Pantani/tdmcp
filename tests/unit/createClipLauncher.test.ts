import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { z } from "zod";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  buildLauncherScript,
  createClipLauncherImpl,
  createClipLauncherSchema,
} from "../../src/tools/layer2/createClipLauncher.js";
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
function run(args: z.input<typeof createClipLauncherSchema>) {
  return createClipLauncherImpl(makeCtx(), createClipLauncherSchema.parse(args));
}

/** Decodes the base64 payload the generated script embeds, so tests can assert on it. */
function decodePayload(script: string): {
  comp: string;
  name: string;
  cues: string[];
  rows: number;
  cols: number;
  morph_time: number;
  morph_hook: string;
  button_cb: string;
} {
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

describe("create_clip_launcher", () => {
  it("round-trips the payload (cue names, grid, morph) through the embedded base64 blob", () => {
    const payload = {
      comp: "/project1",
      name: "launcher",
      cues: ["intro", "drop", "break", "outro"],
      rows: 2,
      cols: 2,
      morph_time: 1.5,
      morph_hook: "x",
      button_cb: "y",
    };
    expect(decodePayload(buildLauncherScript(payload))).toEqual(payload);
  });

  it("builds the panel COMP with one clip button per cue, labelled by cue name", async () => {
    const cap = captureExec({
      comp: "/project1",
      launcher: "/project1/launcher",
      rows: 1,
      cols: 3,
      morph_time: 0,
      buttons: [
        { button: "/project1/launcher/button1", cue: "a" },
        { button: "/project1/launcher/button2", cue: "b" },
        { button: "/project1/launcher/button3", cue: "c" },
      ],
      warnings: [],
    });

    const result = await run({ cues: ["a", "b", "c"] });
    const text = textOf(result);
    expect(text).toContain("Built clip launcher /project1/launcher");
    expect(text).toContain("3 clip(s)");

    // The generated Python must build a Container COMP holding buttonCOMP clips.
    const script = cap.scripts[0] ?? "";
    expect(script).toContain("td.containerCOMP");
    expect(script).toContain("td.buttonCOMP");
    // Each button is labelled with its cue name.
    expect(script).toContain("_bt.par.label = _cue");

    // The payload carries every cue name, in order.
    const payload = decodePayload(script);
    expect(payload.cues).toEqual(["a", "b", "c"]);
  });

  it("wires a Panel Execute DAT whose callback reuses manage_cue's recall/morph mechanism", async () => {
    const cap = captureExec({
      comp: "/project1",
      launcher: "/project1/launcher",
      rows: 1,
      cols: 2,
      morph_time: 2,
      buttons: [
        { button: "/project1/launcher/button1", cue: "warm" },
        { button: "/project1/launcher/button2", cue: "cold" },
      ],
      warnings: [],
    });

    await run({ cues: ["warm", "cold"], morph_time: 2 });
    const script = cap.scripts[0] ?? "";

    // A panelexecuteDAT watches the buttons — and ITS `panels` param must be set to the
    // button paths, otherwise the callback never fires (the verified create_control_surface
    // gotcha). The button→cue map is stored on the panel for the callback to look up.
    expect(script).toContain("td.panelexecuteDAT");
    expect(script).toContain("_pe.par.panels");
    expect(script).toContain('_surf.store("tdmcp_launcher_cues"');

    const payload = decodePayload(script);
    // The callback fires the cue via the SAME mechanism manage_cue uses: instant recall sets
    // the params directly; a morph writes a `tdmcp_cue_transition` record and activates the
    // `cue_morph` Execute DAT (the MORPH_HOOK engine shared with manage_cue).
    const cb = payload.button_cb;
    expect(cb).toContain("def onOffToOn");
    expect(cb).toContain("comp.fetch('tdmcp_cues'");
    expect(cb).toContain("tdmcp_cue_transition");
    expect(cb).toContain("comp.op('cue_morph')");
    expect(cb).toContain("pr.val = v");

    // With a morph_time > 0 the build also ensures the cue_morph hook DAT runs on the COMP,
    // and the embedded morph hook is manage_cue's exact frame-eased engine.
    expect(script).toContain('td.executeDAT, "cue_morph"');
    expect(payload.morph_hook).toContain("def onFrameStart");
    expect(payload.morph_time).toBe(2);
  });

  it("derives a near-square grid from the cue count when rows/cols are omitted", async () => {
    const cap = captureExec({
      comp: "/project1",
      launcher: "/project1/launcher",
      rows: 2,
      cols: 2,
      morph_time: 0,
      buttons: [
        { button: "/project1/launcher/b1", cue: "a" },
        { button: "/project1/launcher/b2", cue: "b" },
        { button: "/project1/launcher/b3", cue: "c" },
        { button: "/project1/launcher/b4", cue: "d" },
      ],
      warnings: [],
    });

    await run({ cues: ["a", "b", "c", "d"] });
    // 4 cues → ceil(sqrt(4)) = 2 cols, 2 rows.
    const payload = decodePayload(cap.scripts[0] ?? "");
    expect(payload.cols).toBe(2);
    expect(payload.rows).toBe(2);
  });

  it("respects an explicit cols, deriving the row count to cover all cues", async () => {
    const cap = captureExec({
      comp: "/project1",
      launcher: "/project1/launcher",
      rows: 2,
      cols: 3,
      morph_time: 0,
      buttons: [],
      warnings: [],
    });

    await run({ cues: ["a", "b", "c", "d", "e"], cols: 3 });
    // 5 cues across 3 cols → 2 rows.
    const payload = decodePayload(cap.scripts[0] ?? "");
    expect(payload.cols).toBe(3);
    expect(payload.rows).toBe(2);
  });

  it("returns an isError result (without throwing) when the COMP is missing", async () => {
    captureExec({
      comp: "/nope",
      buttons: [],
      warnings: [],
      fatal: "COMP not found: /nope",
    });

    const result = await run({ cues: ["a"], comp_path: "/nope" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Could not build clip launcher");
    expect(textOf(result)).toContain("COMP not found: /nope");
  });

  it("survives cue names that would break naive quoting (quotes, newlines, unicode)", () => {
    const payload = {
      comp: "/project1",
      name: "launcher",
      cues: ["line1\nline2 'quoted' ★", '}{")'],
      rows: 1,
      cols: 2,
      morph_time: 0,
      morph_hook: "h",
      button_cb: "c",
    };
    expect(decodePayload(buildLauncherScript(payload))).toEqual(payload);
  });
});
