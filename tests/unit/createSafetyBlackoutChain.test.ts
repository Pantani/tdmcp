import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { createSafetyBlackoutChainImpl } from "../../src/tools/layer1/createSafetyBlackoutChain.js";
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

const DEFAULTS = {
  parent_path: "/project1",
  fade_seconds: 1.5,
  fade_curve: "ease_in_out",
  initial_state: "live",
  arm_emergency_snap: true,
  hotkey: "ctrl.b",
  recovery_mode: "manual",
  show_safe_label: "SHOW SAFE",
  expose_controls: true,
} as const;

describe("create_safety_blackout_chain", () => {
  it("builds the full chain with default args", async () => {
    const bodies = captureCreateBodies();
    const result = await createSafetyBlackoutChainImpl(makeCtx(), { ...DEFAULTS });

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("/project1/safety");
    expect(text).toContain("/project1/safety/out1");

    const byName = (n: string) => bodies.find((b) => b.name === n);
    // Default source — no input_path → Ramp TOP test source.
    expect(byName("src")?.type).toBe("rampTOP");
    // Trigger nodes.
    expect(byName("blackoutToggle")?.type).toBe("constantCHOP");
    expect(byName("emergencyPulse")?.type).toBe("constantCHOP");
    expect(byName("keyboardin1")?.type).toBe("keyboardinCHOP");
    expect(byName("merge1")?.type).toBe("mathCHOP");
    expect(byName("merge1")?.parameters).toMatchObject({ chopop: "max" });
    expect(byName("target")?.type).toBe("logicCHOP");
    expect(byName("fadeSpeed")?.type).toBe("speedCHOP");
    expect(byName("curve")?.type).toBe("lookupCHOP");
    // Lookup CHOP has no `dat` par on TD 099 — curve is fed via DAT-to-CHOP into input 2.
    expect(byName("curve")?.parameters?.dat).toBeUndefined();
    expect(byName("curveTable")?.type).toBe("tableDAT");
    expect(byName("curveChop")?.type).toBe("dattoCHOP");
    expect(byName("curveChop")?.parameters).toMatchObject({ dat: "/project1/safety/curveTable" });
    expect(byName("dimNull")?.type).toBe("nullCHOP");
    expect(byName("dim")?.type).toBe("levelTOP");
    expect(byName("emergencyGate")?.type).toBe("levelTOP");
    expect(byName("showSafeLabel")?.type).toBe("textTOP");
    expect(byName("composite1")?.type).toBe("compositeTOP");
    expect(byName("out1")?.type).toBe("nullTOP");

    // No cook-time chopExecuteDAT.
    expect(bodies.find((b) => b.type === "chopexecuteDAT")).toBeUndefined();
    expect(bodies.find((b) => b.type === "chopExecuteDAT")).toBeUndefined();
  });

  it("pulls an external source through a Select TOP (input_path)", async () => {
    const bodies = captureCreateBodies();
    await createSafetyBlackoutChainImpl(makeCtx(), {
      ...DEFAULTS,
      input_path: "/scene/master_out",
    });
    const src = bodies.find((b) => b.name === "src");
    expect(src?.type).toBe("selectTOP");
    expect(src?.parameters).toMatchObject({ top: "/scene/master_out" });
  });

  it("drives the speed CHOP factor from the Fadeseconds par with a safe floor", async () => {
    const scripts = captureExecScripts();
    await createSafetyBlackoutChainImpl(makeCtx(), { ...DEFAULTS });

    const speed = scripts.find((s) => s.includes("par.speed") && s.includes("Fadeseconds"));
    expect(speed).toBeDefined();
    expect(speed).toContain("1/max(0.001,");
    expect(speed).toContain("type(_p.mode).EXPRESSION");
  });

  it("ties the dim Level TOP brightness1 to dimNull (1 - dim)", async () => {
    const scripts = captureExecScripts();
    await createSafetyBlackoutChainImpl(makeCtx(), { ...DEFAULTS });

    const dimExpr = scripts.find(
      (s) =>
        s.includes("/project1/safety/dim") &&
        s.includes("brightness1") &&
        s.includes("/project1/safety/dimNull"),
    );
    expect(dimExpr).toBeDefined();
    expect(dimExpr).toContain("1 - op");
    expect(dimExpr).toContain("type(_p.mode).EXPRESSION");
  });

  it("hard-cuts via the Emergency Level TOP brightness1 expression", async () => {
    const scripts = captureExecScripts();
    await createSafetyBlackoutChainImpl(makeCtx(), { ...DEFAULTS });

    const emergency = scripts.find(
      (s) =>
        s.includes("/project1/safety/emergencyGate") &&
        s.includes("brightness1") &&
        s.includes("par.Emergency"),
    );
    expect(emergency).toBeDefined();
    expect(emergency).toContain("(0 if op");
    expect(emergency).toContain("type(_p.mode).EXPRESSION");
  });

  it("initial_state='black' sets the Blackout par default true", async () => {
    const scripts = captureExecScripts();
    await createSafetyBlackoutChainImpl(makeCtx(), {
      ...DEFAULTS,
      initial_state: "black",
    });
    const safetyPars = scripts.find(
      (s) => s.includes('appendToggle("Blackout"') && s.includes("Safety"),
    );
    expect(safetyPars).toBeDefined();
    expect(safetyPars).toContain("_bp.val = True");
  });

  it("initial_state='held' sets the Hold par default true", async () => {
    const scripts = captureExecScripts();
    await createSafetyBlackoutChainImpl(makeCtx(), {
      ...DEFAULTS,
      initial_state: "held",
    });
    const safetyPars = scripts.find(
      (s) => s.includes('appendToggle("Hold"') && s.includes("Safety"),
    );
    expect(safetyPars).toBeDefined();
    expect(safetyPars).toContain("_hp.val = True");
  });

  it("appends Safety pars directly even when expose_controls=false", async () => {
    const scripts = captureExecScripts();
    await createSafetyBlackoutChainImpl(makeCtx(), {
      ...DEFAULTS,
      expose_controls: false,
    });
    const safety = scripts.find(
      (s) =>
        s.includes("appendCustomPage") &&
        s.includes("Safety") &&
        s.includes('appendToggle("Blackout"'),
    );
    expect(safety).toBeDefined();
    // And no control-panel payload was emitted.
    expect(
      scripts.find((s) => s.includes("b64decode") && s.includes("appendCustomPage")),
    ).toBeUndefined();
  });

  it("hotkey=null skips the Keyboard In CHOP", async () => {
    const bodies = captureCreateBodies();
    await createSafetyBlackoutChainImpl(makeCtx(), {
      ...DEFAULTS,
      hotkey: null,
    });
    expect(bodies.find((b) => b.type === "keyboardinCHOP")).toBeUndefined();
  });

  it("watchdog_channel adds a Select CHOP with split path/channel", async () => {
    const bodies = captureCreateBodies();
    await createSafetyBlackoutChainImpl(makeCtx(), {
      ...DEFAULTS,
      watchdog_channel: "/project1/health/null1:alarm",
    });
    const wd = bodies.find((b) => b.name === "watchdog");
    expect(wd?.type).toBe("selectCHOP");
    expect(wd?.parameters).toMatchObject({
      chop: "/project1/health/null1",
      channames: "alarm",
    });
  });

  it("fade_seconds=0 still factors via the 0.001 floor (no divide-by-zero)", async () => {
    const bodies = captureCreateBodies();
    await createSafetyBlackoutChainImpl(makeCtx(), {
      ...DEFAULTS,
      fade_seconds: 0,
    });
    const speed = bodies.find((b) => b.name === "fadeSpeed");
    expect(speed?.type).toBe("speedCHOP");
    // speed was set to 1/0.001 = 1000 on creation (expression overrides at cook time).
    expect(speed?.parameters).toMatchObject({ speed: 1000 });
  });

  it("show_safe_label='' skips the Text TOP + Composite TOP", async () => {
    const bodies = captureCreateBodies();
    await createSafetyBlackoutChainImpl(makeCtx(), {
      ...DEFAULTS,
      show_safe_label: "",
    });
    expect(bodies.find((b) => b.name === "showSafeLabel")).toBeUndefined();
    expect(bodies.find((b) => b.name === "composite1")).toBeUndefined();
    // out1 still exists.
    expect(bodies.find((b) => b.name === "out1")?.type).toBe("nullTOP");
  });
});
