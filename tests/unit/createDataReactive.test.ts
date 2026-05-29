import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  createDataReactiveImpl,
  createDataReactiveSchema,
} from "../../src/tools/layer2/createDataReactive.js";
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

/** Decode the base64 payload embedded in a buildPayloadScript-generated script. */
function decodePayload(script: string): Record<string, unknown> {
  const match = /b64decode\("([^"]+)"\)/.exec(script);
  if (!match?.[1]) throw new Error("No b64decode call found in script");
  return JSON.parse(Buffer.from(match[1], "base64").toString("utf8")) as Record<string, unknown>;
}

/** Capture the script body sent to /api/exec and return a report JSON in stdout. */
function captureExec(reportJson: string): { capturedScript: () => string } {
  let captured = "";
  server.use(
    http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
      const body = (await request.json()) as { script?: string };
      captured = body.script ?? "";
      return HttpResponse.json({ ok: true, data: { result: null, stdout: reportJson } });
    }),
  );
  return { capturedScript: () => captured };
}

describe("createDataReactiveSchema", () => {
  it("requires at least one mapping", () => {
    expect(() =>
      createDataReactiveSchema.parse({
        target: "/project1/myComp",
        source_chop: "/project1/data/out",
        mappings: [],
      }),
    ).toThrow();
  });

  it("defaults in_min, in_max, out_min, out_max to 0/1/0/1", () => {
    const parsed = createDataReactiveSchema.parse({
      target: "/project1/myComp",
      source_chop: "/project1/data/out",
      mappings: [{ param: "Speed", channel: "temperature" }],
    });
    const m = parsed.mappings[0]!;
    expect(m.in_min).toBe(0);
    expect(m.in_max).toBe(1);
    expect(m.out_min).toBe(0);
    expect(m.out_max).toBe(1);
  });

  it("defaults smooth to 0", () => {
    const parsed = createDataReactiveSchema.parse({
      target: "/project1/myComp",
      source_chop: "/project1/data/out",
      mappings: [{ param: "Speed", channel: "level" }],
    });
    expect(parsed.smooth).toBe(0);
  });

  it("coerces numeric strings in mappings and smooth", () => {
    const parsed = createDataReactiveSchema.parse({
      target: "/project1/myComp",
      source_chop: "/project1/data/out",
      mappings: [
        {
          param: "Speed",
          channel: "level",
          in_min: "0",
          in_max: "100",
          out_min: "0",
          out_max: "1",
        },
      ],
      smooth: "0.2",
    });
    expect(parsed.mappings[0]?.in_max).toBe(100);
    expect(parsed.smooth).toBe(0.2);
  });
});

describe("createDataReactiveImpl — payload", () => {
  it("sends correct target/source/mappings in the base64 payload", async () => {
    const successReport = JSON.stringify({
      target: "/project1/myComp",
      source_chop: "/project1/data/out",
      bound: [
        {
          param: "Speed",
          channel: "temperature",
          expr: "(0.0) + clamp((op('/project1/data/out')['temperature'] - (0.0)) / (100.0), 0, 1) * (1.0)",
        },
      ],
      smoothed: false,
      warnings: [],
    });
    const { capturedScript } = captureExec(successReport);

    await createDataReactiveImpl(makeCtx(), {
      target: "/project1/myComp",
      source_chop: "/project1/data/out",
      mappings: [
        { param: "Speed", channel: "temperature", in_min: 0, in_max: 100, out_min: 0, out_max: 1 },
      ],
      smooth: 0,
    });

    const payload = decodePayload(capturedScript());
    expect(payload.target).toBe("/project1/myComp");
    expect(payload.source_chop).toBe("/project1/data/out");
    expect(payload.smooth).toBe(0);

    const mappings = payload.mappings as Array<Record<string, unknown>>;
    expect(mappings).toHaveLength(1);
    const m = mappings[0]!;
    expect(m.param).toBe("Speed");
    expect(m.channel).toBe("temperature");
    expect(m.in_min).toBe(0);
    expect(m.in_max).toBe(100);
    expect(m.out_min).toBe(0);
    expect(m.out_max).toBe(1);
  });

  it("includes select_name/lag_name derived from first channel when smooth > 0", async () => {
    const successReport = JSON.stringify({
      target: "/project1/vis",
      source_chop: "/project1/sensor/out",
      bound: [],
      smoothed: true,
      smoothing_select: "/project1/humidity_sel",
      smoothing_lag: "/project1/humidity_lag",
      warnings: [],
    });
    const { capturedScript } = captureExec(successReport);

    await createDataReactiveImpl(makeCtx(), {
      target: "/project1/vis",
      source_chop: "/project1/sensor/out",
      mappings: [
        { param: "Color", channel: "humidity", in_min: 0, in_max: 100, out_min: 0, out_max: 1 },
      ],
      smooth: 0.3,
    });

    const payload = decodePayload(capturedScript());
    expect(payload.smooth).toBe(0.3);
    expect(payload.select_name).toBe("humidity_sel");
    expect(payload.lag_name).toBe("humidity_lag");
  });

  it("sends multiple mappings correctly", async () => {
    const successReport = JSON.stringify({
      target: "/project1/myComp",
      source_chop: "/project1/data/out",
      bound: [
        { param: "Speed", channel: "wind", expr: "..." },
        { param: "Brightness", channel: "light", expr: "..." },
      ],
      smoothed: false,
      warnings: [],
    });
    const { capturedScript } = captureExec(successReport);

    await createDataReactiveImpl(makeCtx(), {
      target: "/project1/myComp",
      source_chop: "/project1/data/out",
      mappings: [
        { param: "Speed", channel: "wind", in_min: 0, in_max: 50, out_min: 0, out_max: 2 },
        {
          param: "Brightness",
          channel: "light",
          in_min: 0,
          in_max: 100000,
          out_min: 0,
          out_max: 1,
        },
      ],
      smooth: 0,
    });

    const payload = decodePayload(capturedScript());
    const mappings = payload.mappings as Array<Record<string, unknown>>;
    expect(mappings).toHaveLength(2);
    expect(mappings[0]?.channel).toBe("wind");
    expect(mappings[0]?.in_max).toBe(50);
    expect(mappings[0]?.out_max).toBe(2);
    expect(mappings[1]?.channel).toBe("light");
    expect(mappings[1]?.in_max).toBe(100000);
  });
});

describe("createDataReactiveImpl — happy path summary", () => {
  it("returns a friendly summary with the bound count and target path", async () => {
    const successReport = JSON.stringify({
      target: "/project1/myComp",
      source_chop: "/project1/data/out",
      bound: [
        { param: "Speed", channel: "temperature", expr: "..." },
        { param: "Color", channel: "humidity", expr: "..." },
      ],
      smoothed: false,
      warnings: [],
    });
    captureExec(successReport);

    const result: CallToolResult = await createDataReactiveImpl(makeCtx(), {
      target: "/project1/myComp",
      source_chop: "/project1/data/out",
      mappings: [
        { param: "Speed", channel: "temperature", in_min: 0, in_max: 100, out_min: 0, out_max: 1 },
        { param: "Color", channel: "humidity", in_min: 0, in_max: 100, out_min: 0, out_max: 1 },
      ],
      smooth: 0,
    });

    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text: string }>)
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    expect(text).toContain("2 data channel(s)");
    expect(text).toContain("/project1/myComp");
  });

  it("includes smoothing info in summary when smoothed", async () => {
    const successReport = JSON.stringify({
      target: "/project1/vis",
      source_chop: "/project1/sensor/out",
      bound: [{ param: "Color", channel: "humidity", expr: "..." }],
      smoothed: true,
      smoothing_lag: "/project1/humidity_lag",
      warnings: [],
    });
    captureExec(successReport);

    const result: CallToolResult = await createDataReactiveImpl(makeCtx(), {
      target: "/project1/vis",
      source_chop: "/project1/sensor/out",
      mappings: [
        { param: "Color", channel: "humidity", in_min: 0, in_max: 100, out_min: 0, out_max: 1 },
      ],
      smooth: 0.3,
    });

    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text: string }>)
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    expect(text).toContain("smoothing");
    expect(text).toContain("0.3s");
  });
});

describe("createDataReactiveImpl — bridge fatal", () => {
  it("returns isError=true on target-not-found fatal without throwing", async () => {
    const fatalReport = JSON.stringify({
      target: "/project1/missing",
      source_chop: "/project1/data/out",
      bound: [],
      smoothed: false,
      warnings: [],
      fatal: "Target not found: /project1/missing",
    });
    captureExec(fatalReport);

    let result: CallToolResult | undefined;
    await expect(
      (async () => {
        result = await createDataReactiveImpl(makeCtx(), {
          target: "/project1/missing",
          source_chop: "/project1/data/out",
          mappings: [
            {
              param: "Speed",
              channel: "temperature",
              in_min: 0,
              in_max: 100,
              out_min: 0,
              out_max: 1,
            },
          ],
          smooth: 0,
        });
      })(),
    ).resolves.not.toThrow();

    expect(result?.isError).toBe(true);
    const text =
      (result?.content as Array<{ type: string; text: string }> | undefined)
        ?.filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("") ?? "";
    expect(text).toContain("not found");
  });

  it("does not throw when the bridge returns empty stdout (connection error)", async () => {
    server.use(http.post(`${TD_BASE}/api/exec`, () => HttpResponse.error()));

    let result: CallToolResult | undefined;
    await expect(
      (async () => {
        result = await createDataReactiveImpl(makeCtx(), {
          target: "/project1/myComp",
          source_chop: "/project1/data/out",
          mappings: [
            {
              param: "Speed",
              channel: "temperature",
              in_min: 0,
              in_max: 100,
              out_min: 0,
              out_max: 1,
            },
          ],
          smooth: 0,
        });
      })(),
    ).resolves.not.toThrow();

    expect(result?.isError).toBe(true);
  });
});

describe("createDataReactiveImpl — warnings do not fail the result", () => {
  it("succeeds with isError=false when warnings are present", async () => {
    const warnReport = JSON.stringify({
      target: "/project1/myComp",
      source_chop: "/project1/data/out",
      bound: [{ param: "Speed", channel: "temperature", expr: "..." }],
      smoothed: false,
      warnings: ["Channel 'temperature' not present on /project1/data/out yet; binding anyway."],
    });
    captureExec(warnReport);

    const result: CallToolResult = await createDataReactiveImpl(makeCtx(), {
      target: "/project1/myComp",
      source_chop: "/project1/data/out",
      mappings: [
        { param: "Speed", channel: "temperature", in_min: 0, in_max: 100, out_min: 0, out_max: 1 },
      ],
      smooth: 0,
    });

    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text: string }>)
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    expect(text).toContain("1 warning(s)");
  });
});
