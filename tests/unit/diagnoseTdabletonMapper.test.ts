import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  diagnoseTdabletonMapperImpl,
  diagnoseTdabletonMapperSchema,
} from "../../src/tools/layer2/diagnoseTdabletonMapper.js";
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

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

function jsonOf<T>(result: { content: Array<{ type: string; text?: string }> }): T {
  const text = textOf(result);
  const match = /```json\n([\s\S]*?)\n```/.exec(text);
  if (!match?.[1]) throw new Error("result did not contain a JSON fence");
  return JSON.parse(match[1]) as T;
}

function decodePayload(script: string): Record<string, unknown> {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (!b64) throw new Error("script did not embed a base64 payload");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as Record<string, unknown>;
}

function mockExecWithReport(report: Record<string, unknown>): { scripts: string[] } {
  const scripts: string[] = [];
  server.use(
    http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
      const body = (await request.json()) as { script?: unknown; return_output?: unknown };
      if (typeof body.script === "string") scripts.push(body.script);
      return HttpResponse.json({
        ok: true,
        data: { result: null, stdout: `td log\n${JSON.stringify(report)}\n` },
      });
    }),
  );
  return { scripts };
}

function happyReport(overrides: Record<string, unknown> = {}) {
  return {
    parent_path: "/project1",
    repair_requested: false,
    expected: {
      source_chop: "/project1/hand_ableton_mapper/mapper_send",
      reorder: "map1 map2 map3 map4",
      channels: ["map1", "map2", "map3", "map4"],
    },
    mapper: {
      found: true,
      path: "/map/t3/TDA_Mapper",
      search_mode: "auto",
      candidates: ["/map/t3/TDA_Mapper"],
      parameters: {
        Oscinputchop: "/project1/hand_ableton_mapper/mapper_send",
        Reorder: "map1 map2 map3 map4",
        Bypass1: false,
        Bypass2: false,
        Bypass3: false,
        Bypass4: false,
        Min1: 0,
        Max1: 1,
        Min2: 0,
        Max2: 1,
        Min3: 0,
        Max3: 1,
        Min4: 0,
        Max4: 1,
      },
      bypass_enabled: [],
      range_issues: [],
    },
    source: {
      exists: true,
      path: "/project1/hand_ableton_mapper/mapper_send",
      channels: ["map1", "map2", "map3", "map4"],
      missing_channels: [],
    },
    symptoms: [],
    warnings: [],
    repairs_applied: [],
    ...overrides,
  };
}

describe("diagnose_tdableton_mapper", () => {
  it("defaults and payload script target the TDAbleton mapper diagnosis", async () => {
    const { scripts } = mockExecWithReport(happyReport());

    const result = await diagnoseTdabletonMapperImpl(
      makeCtx(),
      diagnoseTdabletonMapperSchema.parse({}),
    );

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("no mapper symptoms found");
    expect(textOf(result)).toContain("/map/t3/TDA_Mapper");

    const script = scripts[0] as string;
    expect(script).toBeDefined();
    expect(script).toContain("TDA_Mapper");
    expect(script).toContain("source_missing_channels");
    expect(script).toContain("Oscinputchop");
    expect(script).toContain("result = json.dumps(report)");

    const payload = decodePayload(script);
    expect(payload.parent_path).toBe("/project1");
    expect(payload.mapper_path).toBeUndefined();
    expect(payload.source_chop).toBe("/project1/hand_ableton_mapper/mapper_send");
    expect(payload.expected_reorder).toBe("map1 map2 map3 map4");
    expect(payload.repair).toBe(false);
  });

  it("happy report is returned as structured JSON with warnings and repairs", async () => {
    mockExecWithReport(
      happyReport({
        repairs_applied: ["Oscinputchop=/project1/hand_ableton_mapper/mapper_send"],
      }),
    );

    const result = await diagnoseTdabletonMapperImpl(
      makeCtx(),
      diagnoseTdabletonMapperSchema.parse({ repair: true }),
    );

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("1 repair(s) applied");

    const report = jsonOf<Record<string, unknown>>(result);
    expect(report.warnings).toEqual([]);
    expect(report.repairs_applied).toEqual([
      "Oscinputchop=/project1/hand_ableton_mapper/mapper_send",
    ]);
    expect(report.symptoms).toEqual([]);
  });

  it("fatal report returns errorResult without throwing", async () => {
    mockExecWithReport({
      parent_path: "/missing",
      repair_requested: false,
      expected: {
        source_chop: "/project1/hand_ableton_mapper/mapper_send",
        reorder: "map1 map2 map3 map4",
        channels: ["map1", "map2", "map3", "map4"],
      },
      mapper: {
        found: false,
        path: null,
        search_mode: "auto",
        candidates: [],
        parameters: {},
        bypass_enabled: [],
        range_issues: [],
      },
      source: {
        exists: false,
        path: "/project1/hand_ableton_mapper/mapper_send",
        channels: [],
        missing_channels: [],
      },
      symptoms: [],
      warnings: [],
      repairs_applied: [],
      fatal: "Parent COMP not found: /missing",
    });

    const result = await diagnoseTdabletonMapperImpl(
      makeCtx(),
      diagnoseTdabletonMapperSchema.parse({ parent_path: "/missing" }),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("diagnose_tdableton_mapper failed");
    expect(textOf(result)).toContain("Parent COMP not found: /missing");
  });
});
