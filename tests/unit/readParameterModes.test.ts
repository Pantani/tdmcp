import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  readParameterModesImpl,
  readParameterModesSchema,
} from "../../src/tools/layer3/readParameterModes.js";
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

describe("read_parameter_modes", () => {
  it("captures the path and key filter in the bridge payload", async () => {
    const capture = capturePayload({
      path: "/project1/noise1",
      parameters: { period: { name: "period", mode: "EXPRESSION", expression: "absTime.frame" } },
      warnings: [],
    });
    const result = await readParameterModesImpl(makeCtx(), {
      path: "/project1/noise1",
      keys: ["period"],
    });
    expect(result.isError).toBeFalsy();
    expect(capture.payload).toEqual({ path: "/project1/noise1", keys: ["period"] });
    expect(result.structuredContent?.parameters).toMatchObject({
      period: { mode: "EXPRESSION" },
    });
  });

  it("returns isError on bridge fatal without throwing", async () => {
    capturePayload({
      path: "/project1/missing",
      parameters: {},
      warnings: [],
      fatal: "Node not found: /project1/missing",
    });
    const result = await readParameterModesImpl(makeCtx(), { path: "/project1/missing" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.type).toBe("text");
  });

  it("validates input shape", () => {
    expect(() => readParameterModesSchema.parse({ path: "/project1/noise1" })).not.toThrow();
    expect(() => readParameterModesSchema.parse({ path: 123 })).toThrow();
  });
});
