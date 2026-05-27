import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { createPanicImpl } from "../../src/tools/layer2/createPanic.js";
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

/** Pulls the `_p.expr = "<json>"` literal out of a Python step and JSON-decodes it. */
function exprLiteral(script: string | undefined): string {
  const m = /_p\.expr = ("(?:\\.|[^"\\])*")/.exec(script ?? "");
  if (!m?.[1]) throw new Error("no _p.expr literal found in script");
  return JSON.parse(m[1]) as string;
}

// Records every POST /api/nodes body so a test can assert what ops were created and with
// which parameters. Mirrors the same name-echo behaviour as the default handler.
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

// Records every POST /api/exec script so a test can assert which Python steps ran.
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

describe("create_panic", () => {
  it("builds a panic COMP with a Null TOP output and a default test source", async () => {
    const bodies = captureCreateBodies();
    const result = await createPanicImpl(makeCtx(), {
      blackout: false,
      freeze: false,
      expose_controls: true,
      parent_path: "/project1",
    });

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("/project1/panic");
    expect(text).toContain("/project1/panic/out1");

    // No input_path → a Ramp TOP test source so it builds + previews standalone.
    expect(bodies.find((b) => b.name === "src")?.type).toBe("rampTOP");
    // Freeze = Cache TOP, Blackout = Level TOP, output = Null TOP.
    expect(bodies.find((b) => b.name === "freeze")?.type).toBe("cacheTOP");
    expect(bodies.find((b) => b.name === "blackout")?.type).toBe("levelTOP");
    expect(bodies.find((b) => b.name === "out1")?.type).toBe("nullTOP");
  });

  it("pulls an external source through a Select TOP (works across COMPs)", async () => {
    const created: CreatedNodeBody[] = [];
    server.use(
      http.post(`${TD_BASE}/api/nodes`, async ({ request }) => {
        const body = (await request.json()) as CreatedNodeBody;
        created.push(body);
        const name = body.name ?? `${body.type.replace(/[^a-zA-Z0-9]/g, "").toLowerCase()}1`;
        return HttpResponse.json({
          ok: true,
          data: { path: `${body.parent_path}/${name}`, type: body.type, name },
        });
      }),
    );

    const result = await createPanicImpl(makeCtx(), {
      input_path: "/scene/out1",
      blackout: false,
      freeze: false,
      expose_controls: false,
      parent_path: "/project1",
    });

    expect(result.isError).toBeFalsy();
    const src = created.find((b) => b.name === "src");
    expect(src?.type).toBe("selectTOP");
    // The source is referenced by absolute path, not a (cross-COMP-illegal) wire.
    expect(src?.parameters).toMatchObject({ top: "/scene/out1" });
  });

  it("drives the Level TOP brightness1 to 0 when Blackout is on (instant black)", async () => {
    const scripts = captureExecScripts();
    await createPanicImpl(makeCtx(), {
      blackout: false,
      freeze: false,
      expose_controls: true,
      parent_path: "/project1",
    });

    // brightness1 (NOT gain) is driven by an expression referencing the container's
    // Blackout par by ABSOLUTE path, switched to EXPRESSION mode via type(par.mode).
    const blackout = scripts.find((s) => s.includes("brightness1") && s.includes("par.Blackout"));
    expect(blackout).toBeDefined();
    expect(blackout).toContain('op("/project1/panic/blackout").par.brightness1');
    expect(blackout).toContain("type(_p.mode).EXPRESSION");
    // The expr is a JSON-encoded string literal; decode it and assert the real expression.
    expect(exprLiteral(blackout)).toBe('(0 if op("/project1/panic").par.Blackout else 1)');
  });

  it("drives the Cache TOP active to 0 when Freeze is on (holds the last frame)", async () => {
    const scripts = captureExecScripts();
    await createPanicImpl(makeCtx(), {
      blackout: false,
      freeze: false,
      expose_controls: true,
      parent_path: "/project1",
    });

    // Freeze holds the last frame by stopping the Cache TOP capturing: active → 0 when the
    // container's Freeze par is on, referenced by ABSOLUTE path in EXPRESSION mode.
    const freeze = scripts.find((s) => s.includes("par.active") && s.includes("par.Freeze"));
    expect(freeze).toBeDefined();
    expect(freeze).toContain('op("/project1/panic/freeze").par.active');
    expect(freeze).toContain("type(_p.mode).EXPRESSION");
    expect(exprLiteral(freeze)).toBe('(0 if op("/project1/panic").par.Freeze else 1)');
  });

  it("exposes Blackout and Freeze toggle buttons bound to the container params", async () => {
    const scripts = captureExecScripts();
    await createPanicImpl(makeCtx(), {
      blackout: true,
      freeze: false,
      expose_controls: true,
      parent_path: "/project1",
    });

    const panel = scripts.find((s) => s.includes("appendCustomPage"));
    expect(panel).toBeDefined();
    const b64 = /b64decode\("([^"]+)"\)/.exec(panel ?? "")?.[1];
    if (b64 === undefined) throw new Error("panel script did not embed a base64 payload");
    const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as {
      controls: Array<{ name: string; type: string; default?: unknown; bind_to?: string[] }>;
    };

    const blackout = payload.controls.find((c) => c.name === "Blackout");
    expect(blackout?.type).toBe("toggle");
    expect(blackout?.default).toBe(true);
    expect(blackout?.bind_to?.[0]).toBe("/project1/panic.Blackout");

    const freeze = payload.controls.find((c) => c.name === "Freeze");
    expect(freeze?.type).toBe("toggle");
    expect(freeze?.default).toBe(false);
    expect(freeze?.bind_to?.[0]).toBe("/project1/panic.Freeze");
  });

  it("appends the Blackout/Freeze params directly when controls are not exposed", async () => {
    const scripts = captureExecScripts();
    await createPanicImpl(makeCtx(), {
      blackout: false,
      freeze: true,
      expose_controls: false,
      parent_path: "/project1",
    });

    // With no control panel, the COMP must still own the toggles so it's usable via op().par.
    const pars = scripts.find(
      (s) => s.includes('appendToggle("Blackout"') && s.includes('appendToggle("Freeze"'),
    );
    expect(pars).toBeDefined();
    // Initial Freeze state honoured.
    expect(pars).toContain("_fp.val = True");
    // No control-panel payload should be built when controls are off.
    expect(
      scripts.find((s) => s.includes("appendCustomPage") && s.includes("b64decode")),
    ).toBeUndefined();
  });
});
