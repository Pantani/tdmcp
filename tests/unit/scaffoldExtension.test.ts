import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  buildScaffoldExtensionScript,
  scaffoldExtensionImpl,
  scaffoldExtensionSchema,
} from "../../src/tools/layer2/scaffoldExtension.js";
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

/** Decode the base64 payload embedded in a /api/exec script. */
function decodePayload(script: string): Record<string, unknown> {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (!b64) throw new Error("No b64decode found in script");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as Record<string, unknown>;
}

/** Override /api/exec to capture the script and return a custom stdout report. */
function interceptExec(reportJson: Record<string, unknown>): { captured: string[] } {
  const captured: string[] = [];
  server.use(
    http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
      const body = (await request.json()) as { script: string };
      captured.push(body.script);
      return HttpResponse.json({
        ok: true,
        data: { result: null, stdout: JSON.stringify(reportJson) },
      });
    }),
  );
  return { captured };
}

// ---------------------------------------------------------------------------
// 1. Happy path
// ---------------------------------------------------------------------------

describe("scaffold_extension — happy path", () => {
  it("sends the correct payload fields to /api/exec", async () => {
    const happyReport = {
      comp: "/project1/myWidget",
      class_name: "WidgetExt",
      dat: "/project1/myWidget/WidgetExt",
      extension_par: "extension1",
      promote_par: "promoteextension1",
      promoted: true,
      reinit: true,
      warnings: [],
    };
    const { captured } = interceptExec(happyReport);

    const result = await scaffoldExtensionImpl(makeCtx(), {
      comp_path: "/project1/myWidget",
      class_name: "WidgetExt",
      methods: ["onDraw", "getState"],
      promote: true,
      slot: 1,
    });

    expect(result.isError).toBeFalsy();
    expect(captured).toHaveLength(1);

    const payload = decodePayload(captured[0] ?? "");
    expect(payload.comp).toBe("/project1/myWidget");
    expect(payload.class_name).toBe("WidgetExt");
    expect(payload.methods).toEqual(["onDraw", "getState"]);
    expect(payload.promote).toBe(true);
    expect(payload.slot).toBe(1);
  });

  it("produces a friendly summary mentioning class, DAT, promote, and re-init", async () => {
    const happyReport = {
      comp: "/project1/myWidget",
      class_name: "WidgetExt",
      dat: "/project1/myWidget/WidgetExt",
      extension_par: "extension1",
      promote_par: "promoteextension1",
      promoted: true,
      reinit: true,
      warnings: [],
    };
    interceptExec(happyReport);

    const result = await scaffoldExtensionImpl(makeCtx(), {
      comp_path: "/project1/myWidget",
      class_name: "WidgetExt",
      promote: true,
      slot: 1,
    });

    expect(result.isError).toBeFalsy();
    const text = result.content[0];
    expect(text?.type).toBe("text");
    const summary = (text as { type: "text"; text: string }).text;
    expect(summary).toContain("WidgetExt");
    expect(summary).toContain("/project1/myWidget/WidgetExt");
    expect(summary).toContain("promote=true");
    expect(summary).toContain("re-init pulsed");
  });

  it("auto-capitalizes class_name first letter", async () => {
    const happyReport = {
      comp: "/project1/comp1",
      class_name: "WidgetExt",
      dat: "/project1/comp1/WidgetExt",
      extension_par: "extension1",
      promote_par: "promoteextension1",
      promoted: false,
      reinit: true,
      warnings: [],
    };
    const { captured } = interceptExec(happyReport);

    await scaffoldExtensionImpl(makeCtx(), {
      comp_path: "/project1/comp1",
      class_name: "widgetExt", // lowercase first letter — should be auto-capitalized
      promote: false,
      slot: 1,
    });

    const payload = decodePayload(captured[0] ?? "");
    expect(payload.class_name).toBe("WidgetExt"); // capitalized
  });

  it("sends slot=3 when requested", async () => {
    const happyReport = {
      comp: "/project1/comp1",
      class_name: "MyExt",
      dat: "/project1/comp1/MyExt",
      extension_par: "extension3",
      promote_par: "promoteextension3",
      promoted: true,
      reinit: true,
      warnings: [],
    };
    const { captured } = interceptExec(happyReport);

    await scaffoldExtensionImpl(makeCtx(), {
      comp_path: "/project1/comp1",
      class_name: "MyExt",
      promote: true,
      slot: 3,
    });

    const payload = decodePayload(captured[0] ?? "");
    expect(payload.slot).toBe(3);
  });

  it("includes warnings count in summary when bridge returns warnings", async () => {
    const reportWithWarnings = {
      comp: "/project1/comp1",
      class_name: "MyExt",
      dat: "/project1/comp1/MyExt",
      extension_par: "extension1",
      promote_par: null,
      promoted: null,
      reinit: false,
      warnings: ["Extension Promote par not found for slot 1", "reinitextensions par not found"],
    };
    interceptExec(reportWithWarnings);

    const result = await scaffoldExtensionImpl(makeCtx(), {
      comp_path: "/project1/comp1",
      class_name: "MyExt",
      promote: true,
      slot: 1,
    });

    expect(result.isError).toBeFalsy();
    const text = result.content[0];
    const summary = (text as { type: "text"; text: string }).text;
    expect(summary).toContain("2 warning(s)");
  });
});

// ---------------------------------------------------------------------------
// 2. buildScaffoldExtensionScript generates valid Python containing class text
// ---------------------------------------------------------------------------

describe("buildScaffoldExtensionScript", () => {
  it("embeds class_name and methods into the base64 payload", () => {
    const script = buildScaffoldExtensionScript({
      comp: "/project1/c1",
      class_name: "TestExt",
      methods: ["run", "stop"],
      promote: true,
      slot: 1,
    });
    const payload = decodePayload(script);
    expect(payload.class_name).toBe("TestExt");
    expect(payload.methods).toEqual(["run", "stop"]);
    expect(payload.promote).toBe(true);
    expect(payload.slot).toBe(1);
  });

  it("does not string-interpolate the comp path (base64 only)", () => {
    // A path with special chars must not appear literally in the script outside base64
    const dangerousPath = '/project1/it\'s"a"test';
    const script = buildScaffoldExtensionScript({
      comp: dangerousPath,
      class_name: "Ext",
      methods: [],
      promote: false,
      slot: 1,
    });
    // The raw dangerous path must NOT appear literally outside the base64 blob
    const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1] ?? "";
    const scriptWithoutB64 = script.replace(b64, "");
    expect(scriptWithoutB64).not.toContain(dangerousPath);
  });
});

// ---------------------------------------------------------------------------
// 3. Bridge fatal — bridge returns a fatal in the report
// ---------------------------------------------------------------------------

describe("scaffold_extension — bridge fatal", () => {
  it("returns isError=true when COMP is not found, does not throw", async () => {
    interceptExec({
      comp: "/project1/noSuchComp",
      class_name: "WidgetExt",
      dat: null,
      extension_par: null,
      promote_par: null,
      promoted: null,
      reinit: false,
      warnings: [],
      fatal: "COMP not found: /project1/noSuchComp",
    });

    const result = await scaffoldExtensionImpl(makeCtx(), {
      comp_path: "/project1/noSuchComp",
      class_name: "WidgetExt",
      promote: true,
      slot: 1,
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("COMP not found");
  });

  it("returns isError=true when target is not a COMP, does not throw", async () => {
    interceptExec({
      comp: "/project1/noise1",
      class_name: "NoiseExt",
      dat: null,
      extension_par: null,
      promote_par: null,
      promoted: null,
      reinit: false,
      warnings: [],
      fatal: "/project1/noise1 is not a COMP, so it cannot hold an extension.",
    });

    const result = await scaffoldExtensionImpl(makeCtx(), {
      comp_path: "/project1/noise1",
      class_name: "NoiseExt",
      promote: true,
      slot: 1,
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("is not a COMP");
  });

  it("returns isError=true when bridge is offline, does not throw", async () => {
    server.use(http.post(`${TD_BASE}/api/exec`, () => HttpResponse.error()));

    const result = await scaffoldExtensionImpl(makeCtx(), {
      comp_path: "/project1/myWidget",
      class_name: "WidgetExt",
      promote: true,
      slot: 1,
    });

    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Bad input — schema validation
// ---------------------------------------------------------------------------

describe("scaffold_extension — bad input (schema)", () => {
  it("rejects slot < 1", () => {
    expect(() =>
      scaffoldExtensionSchema.parse({
        comp_path: "/project1/comp",
        class_name: "MyExt",
        slot: 0,
      }),
    ).toThrow();
  });

  it("rejects slot > 8", () => {
    expect(() =>
      scaffoldExtensionSchema.parse({
        comp_path: "/project1/comp",
        class_name: "MyExt",
        slot: 9,
      }),
    ).toThrow();
  });

  it("rejects empty class_name", () => {
    expect(() =>
      scaffoldExtensionSchema.parse({
        comp_path: "/project1/comp",
        class_name: "",
      }),
    ).toThrow();
  });

  it("defaults slot to 1 and promote to true when omitted", () => {
    const parsed = scaffoldExtensionSchema.parse({
      comp_path: "/project1/comp",
      class_name: "MyExt",
    });
    expect(parsed.slot).toBe(1);
    expect(parsed.promote).toBe(true);
  });

  it("coerces slot from string '2' to number 2", () => {
    const parsed = scaffoldExtensionSchema.parse({
      comp_path: "/project1/comp",
      class_name: "MyExt",
      slot: "2",
    });
    expect(parsed.slot).toBe(2);
  });
});
