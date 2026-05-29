import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  buildReadParameterModesScript,
  readParameterModesImpl,
  readParameterModesSchema,
} from "../../src/tools/layer3/readParameterModes.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

// ---------------------------------------------------------------------------
// Shared MSW server (onUnhandledRequest:"error" so any unexpected call fails)
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Payload decode helper (mirrors animateParameter.test.ts pattern)
// ---------------------------------------------------------------------------
interface Payload {
  path: string;
  keys: string[] | null;
  non_default_only: boolean;
}

function decodePayload(script: string): Payload {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (b64 === undefined) throw new Error("script did not embed a base64 payload");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as Payload;
}

// ---------------------------------------------------------------------------
// Schema defaults
// ---------------------------------------------------------------------------
describe("readParameterModesSchema", () => {
  it("defaults non_default_only to false", () => {
    const parsed = readParameterModesSchema.parse({ path: "/project1/noise1" });
    expect(parsed.non_default_only).toBe(false);
  });

  it("rejects a call with no path (required field)", () => {
    expect(() => readParameterModesSchema.parse({})).toThrow();
  });

  it("accepts an explicit keys array", () => {
    const parsed = readParameterModesSchema.parse({
      path: "/project1/noise1",
      keys: ["tx", "ty"],
    });
    expect(parsed.keys).toEqual(["tx", "ty"]);
  });
});

// ---------------------------------------------------------------------------
// buildReadParameterModesScript — pure payload round-trip
// ---------------------------------------------------------------------------
describe("buildReadParameterModesScript", () => {
  it("round-trips the payload intact through base64", () => {
    const payload = { path: "/project1/noise1", keys: null, non_default_only: false };
    const script = buildReadParameterModesScript(payload);
    expect(decodePayload(script)).toEqual(payload);
  });

  it("handles paths with quotes and unicode without breaking Python", () => {
    const payload = { path: '/project1/my "node"', keys: null, non_default_only: false };
    const script = buildReadParameterModesScript(payload);
    expect(decodePayload(script)).toEqual(payload);
  });

  it("normalizes evaluated parameter values before JSON encoding", () => {
    const script = buildReadParameterModesScript({
      path: "/project1/noise1",
      keys: null,
      non_default_only: false,
    });
    expect(script).toContain("def _json_safe(value):");
    expect(script).toContain('_entry["value"] = _json_safe(par.eval())');
    expect(script).toContain('getattr(value, "path", None)');
  });
});

// ---------------------------------------------------------------------------
// Happy path — two parameters (one CONSTANT, one EXPRESSION)
// ---------------------------------------------------------------------------
describe("readParameterModesImpl — happy path", () => {
  it("returns structuredContent with both parameters and a correct summary", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script: string };
        capturedScript = body.script;
        return HttpResponse.json({
          ok: true,
          data: {
            result: null,
            stdout: JSON.stringify({
              path: "/project1/noise1",
              type: "noiseTOP",
              name: "noise1",
              parameters: [
                {
                  name: "period",
                  value: 1,
                  mode: "CONSTANT",
                },
                {
                  name: "tx",
                  value: 0.5,
                  mode: "EXPRESSION",
                  expr: "absTime.frame * 0.01",
                },
              ],
              probe: {
                has_mode: true,
                has_expr: true,
                has_bindExpr: true,
                has_exportOP: true,
                mode_repr: "ParMode.CONSTANT",
                par_attrs: ["bindExpr", "eval", "expr", "exportOP", "mode", "name"],
              },
              warnings: [],
            }),
          },
        });
      }),
    );

    const result = await readParameterModesImpl(makeCtx(), {
      path: "/project1/noise1",
      keys: undefined,
      non_default_only: false,
    });

    expect(result.isError).toBeFalsy();

    // Assert the payload that was actually sent to TD
    const payload = decodePayload(capturedScript);
    expect(payload.path).toBe("/project1/noise1");
    expect(payload.keys).toBeNull();
    expect(payload.non_default_only).toBe(false);

    // Assert the structured content
    const sc = result.structuredContent as {
      path: string;
      type: string;
      name: string;
      parameters: Array<{ name: string; mode: string; expr?: string }>;
      warnings: string[];
    };
    expect(sc.path).toBe("/project1/noise1");
    expect(sc.type).toBe("noiseTOP");
    expect(sc.parameters).toHaveLength(2);
    expect(sc.parameters[0]?.name).toBe("period");
    expect(sc.parameters[0]?.mode).toBe("CONSTANT");
    expect(sc.parameters[1]?.name).toBe("tx");
    expect(sc.parameters[1]?.mode).toBe("EXPRESSION");
    expect(sc.parameters[1]?.expr).toBe("absTime.frame * 0.01");
    expect(sc.warnings).toHaveLength(0);

    // Assert the friendly summary text
    const textBlock = result.content[0];
    expect(textBlock?.type).toBe("text");
    const summary = (textBlock as { type: "text"; text: string }).text;
    expect(summary).toContain("2 parameter(s)");
    expect(summary).toContain("/project1/noise1");
    expect(summary).toContain("noiseTOP");
    expect(summary).toContain("1 non-constant");
  });

  it("passes keys and non_default_only through the payload correctly", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script: string };
        capturedScript = body.script;
        return HttpResponse.json({
          ok: true,
          data: {
            result: null,
            stdout: JSON.stringify({
              path: "/project1/noise1",
              type: "noiseTOP",
              name: "noise1",
              parameters: [
                {
                  name: "tx",
                  value: 0.5,
                  mode: "EXPRESSION",
                  expr: "absTime.frame * 0.01",
                },
              ],
              warnings: [],
            }),
          },
        });
      }),
    );

    const result = await readParameterModesImpl(makeCtx(), {
      path: "/project1/noise1",
      keys: ["tx"],
      non_default_only: true,
    });

    expect(result.isError).toBeFalsy();

    const payload = decodePayload(capturedScript);
    expect(payload.keys).toEqual(["tx"]);
    expect(payload.non_default_only).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fatal — node not found → isError, no throw
// ---------------------------------------------------------------------------
describe("readParameterModesImpl — fatal bridge error", () => {
  it("returns isError when the node is not found and does not throw", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        HttpResponse.json({
          ok: true,
          data: {
            result: null,
            stdout: JSON.stringify({
              path: "/project1/nope",
              type: "",
              name: "",
              parameters: [],
              warnings: [],
              fatal: "Node not found: /project1/nope",
            }),
          },
        }),
      ),
    );

    const result = await readParameterModesImpl(makeCtx(), {
      path: "/project1/nope",
      keys: undefined,
      non_default_only: false,
    });

    expect(result.isError).toBe(true);
    const textBlock = result.content[0] as { type: "text"; text: string };
    expect(textBlock.text).toContain("not found");
  });

  it("returns isError when the bridge is unreachable (TdConnectionError) and never throws", async () => {
    server.use(http.post(`${TD_BASE}/api/exec`, () => HttpResponse.error()));

    const result = await readParameterModesImpl(makeCtx(), {
      path: "/project1/noise1",
      keys: undefined,
      non_default_only: false,
    });

    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Bad input — missing required field
// ---------------------------------------------------------------------------
describe("readParameterModesImpl — bad input", () => {
  it("schema rejects a call with no path", () => {
    expect(() => readParameterModesSchema.parse({})).toThrow();
  });
});
