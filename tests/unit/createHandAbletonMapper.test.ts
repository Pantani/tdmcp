import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { z } from "zod";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  createHandAbletonMapperImpl,
  createHandAbletonMapperSchema,
} from "../../src/tools/layer2/createHandAbletonMapper.js";
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

function decodePayload(script: string): Record<string, unknown> {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (!b64) throw new Error("script did not embed a base64 payload");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as Record<string, unknown>;
}

function mockExecReports(reports: Array<Record<string, unknown>>): { scripts: string[] } {
  const scripts: string[] = [];
  const queue = [...reports];
  server.use(
    http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
      const body = (await request.json()) as { script: string };
      scripts.push(body.script);
      const report = queue.shift() ?? {};
      return HttpResponse.json({
        ok: true,
        data: { result: null, stdout: JSON.stringify(report) },
      });
    }),
  );
  return { scripts };
}

function mapperReport(over: Record<string, unknown> = {}) {
  return {
    container_path: "/project1/hand_ableton_mapper",
    hand_chop: "/project1/mp_hand_adapter/hand",
    gesture_chop: "/project1/hand_ableton_mapper/gesture",
    mapper_send: "/project1/hand_ableton_mapper/mapper_send",
    overlay_top: "/project1/hand_ableton_mapper/skeleton_overlay",
    mapper_path: "/map/t3/TDA_Mapper",
    mapper_linked: true,
    channels: ["map1", "map2", "map3", "map4"],
    warnings: [],
    errors: [],
    ...over,
  };
}

function run(args: Partial<z.input<typeof createHandAbletonMapperSchema>> = {}) {
  return createHandAbletonMapperImpl(makeCtx(), createHandAbletonMapperSchema.parse(args));
}

describe("create_hand_ableton_mapper", () => {
  it("schema defaults preserve the live Ableton mapping contract", () => {
    const parsed = createHandAbletonMapperSchema.parse({});
    expect(parsed.parent_path).toBe("/project1");
    expect(parsed.container_name).toBe("hand_ableton_mapper");
    expect(parsed.ensure_hand_tracking).toBe(true);
    expect(parsed.hand_count).toBe(2);
    expect(parsed.closed_distance).toBe(0.025);
    expect(parsed.open_distance).toBe(0.14);
    expect(parsed.create_overlay).toBe(true);
    expect(parsed.link_mapper).toBe(true);
  });

  it("with an explicit hand_chop, builds one payload and returns map1-map4 summary", async () => {
    const { scripts } = mockExecReports([mapperReport()]);
    const result = await run({
      hand_chop: "/project1/custom_hand/hand",
      closed_distance: 0.03,
      open_distance: 0.2,
      smoothing: 0.4,
      mapper_path: "/map/t4/TDA_Mapper",
    });

    expect(result.isError).toBeFalsy();
    expect(scripts).toHaveLength(1);
    expect(textOf(result)).toContain("map1 left pinch");
    expect(textOf(result)).toContain("map4 right wrist roll");

    const payload = decodePayload(scripts[0] as string);
    expect(payload.hand_chop).toBe("/project1/custom_hand/hand");
    expect(payload.closed_distance).toBe(0.03);
    expect(payload.open_distance).toBe(0.2);
    expect(payload.smoothing).toBe(0.4);
    expect(payload.mapper_path).toBe("/map/t4/TDA_Mapper");
  });

  it("embeds the gesture and overlay callbacks for handedness, wrist neutral, and star joints", async () => {
    const { scripts } = mockExecReports([mapperReport()]);
    await run({ hand_chop: "/project1/mp_hand_adapter/hand" });

    const script = scripts[0] as string;
    expect(script).toContain('"map1", "map2", "map3", "map4"');
    expect(script).toContain('"left_wrist": 0.5');
    expect(script).toContain('"right_wrist": 0.5');
    expect(script).toContain("hd < -0.2");
    expect(script).toContain("hd > 0.2");
    expect(script).toContain("PINCH_BONE = (4, 8)");
    expect(script).toContain("STAR_SIZE");
    expect(script).toContain("Oscinputchop");
    expect(script).toContain("TDA_Mapper");
  });

  it("runs setup_hand_tracking first when hand_chop is omitted", async () => {
    const { scripts } = mockExecReports([
      {
        engine: "/project1/MediaPipe",
        hand_dat: "/project1/MediaPipe/hand",
        adapter_hand: "/project1/mp_hand_adapter/hand",
        max_hands: 2,
        coordinate_space: "world",
      },
      mapperReport(),
    ]);

    const result = await run({ tox_path: "/x/MediaPipe.tox" });

    expect(result.isError).toBeFalsy();
    expect(scripts).toHaveLength(2);
    expect(scripts[0]).toContain("HAND_COUNT = 2");
    expect(scripts[0]).toContain("/x/MediaPipe.tox");
    expect(decodePayload(scripts[1] as string).hand_chop).toBe("/project1/mp_hand_adapter/hand");
  });

  it("surfaces a non-linked mapper as a manual TDAbleton mapping step, not an error", async () => {
    mockExecReports([
      mapperReport({
        mapper_path: null,
        mapper_linked: false,
        warnings: ["TDA_Mapper not found. Map Ableton manually."],
      }),
    ]);

    const result = await run({ hand_chop: "/project1/mp_hand_adapter/hand" });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("map or relink the TDA_Mapper manually");
  });

  it("fatal reports return isError with the structured report", async () => {
    mockExecReports([mapperReport({ fatal: "Hand CHOP not found: /missing" })]);

    const result = await run({ hand_chop: "/missing" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Hand CHOP not found");
    expect(textOf(result)).toContain('"fatal"');
  });

  it("bridge connection errors return an error result without throwing", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () => {
        return HttpResponse.error();
      }),
    );

    const result = await run({ hand_chop: "/project1/mp_hand_adapter/hand" });
    expect(result.isError).toBe(true);
    expect(typeof textOf(result)).toBe("string");
  });
});
