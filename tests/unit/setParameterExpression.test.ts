import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  setParameterExpressionImpl,
  setParameterExpressionSchema,
} from "../../src/tools/layer3/setParameterExpression.js";
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

function capturePayload(report: unknown): { payload?: Record<string, unknown> } {
  const capture: { payload?: Record<string, unknown> } = {};
  server.use(
    http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
      const body = (await request.json()) as { script: string };
      const match = /b64decode\("([^"]+)"\)/.exec(body.script);
      if (match?.[1]) {
        capture.payload = JSON.parse(Buffer.from(match[1], "base64").toString("utf8")) as Record<
          string,
          unknown
        >;
      }
      return HttpResponse.json({
        ok: true,
        data: { result: null, stdout: JSON.stringify(report) },
      });
    }),
  );
  return capture;
}

describe("set_parameter_expression", () => {
  it("sends target, expression, and preserve flag through the base64 payload", async () => {
    const expression = "op('/project1/audio/features')['bass'] * 2";
    const capture = capturePayload({
      target: "/project1/level1.brightness1",
      node: "/project1/level1",
      parameter: "brightness1",
      before: { mode: "CONSTANT", value: 1 },
      after: { mode: "EXPRESSION", expression, value: 0.5 },
      warnings: [],
    });
    const result = await setParameterExpressionImpl(makeCtx(), {
      target: "/project1/level1.brightness1",
      expression,
      preserve_on_error: true,
    });
    expect(result.isError).toBeFalsy();
    expect(capture.payload).toMatchObject({
      target: "/project1/level1.brightness1",
      expression,
      preserve_on_error: true,
    });
    expect(result.structuredContent?.after).toMatchObject({ mode: "EXPRESSION", expression });
  });

  it("returns isError on bridge fatal without throwing", async () => {
    capturePayload({
      target: "/project1/level1.nope",
      node: "/project1/level1",
      parameter: "nope",
      before: {},
      after: {},
      warnings: [],
      fatal: "Parameter not found: /project1/level1.nope",
    });
    const result = await setParameterExpressionImpl(makeCtx(), {
      target: "/project1/level1.nope",
      expression: "absTime.seconds",
      preserve_on_error: true,
    });
    expect(result.isError).toBe(true);
  });

  it("validates target and expression", () => {
    expect(() =>
      setParameterExpressionSchema.parse({
        target: "/project1/level1.brightness1",
        expression: "absTime.seconds",
      }),
    ).not.toThrow();
    expect(() =>
      setParameterExpressionSchema.parse({ target: "/project1/level1", expression: "x" }),
    ).toThrow();
    expect(() =>
      setParameterExpressionSchema.parse({
        target: "/project1/level1.brightness1",
        expression: "",
      }),
    ).toThrow();
  });
});
