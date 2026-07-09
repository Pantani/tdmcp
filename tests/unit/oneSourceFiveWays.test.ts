import { describe, expect, it } from "vitest";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  oneSourceFiveWaysImpl,
  oneSourceFiveWaysSchema,
  registerOneSourceFiveWays,
} from "../../src/tools/ai/oneSourceFiveWays.js";
import type { ToolContext } from "../../src/tools/types.js";

function makeCtx(): ToolContext {
  return {
    client: new TouchDesignerClient({ baseUrl: "http://127.0.0.1:1", timeoutMs: 100 }),
    knowledge: {} as never,
    recipes: {} as never,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  };
}

describe("one_source_five_ways", () => {
  it("schema defaults to balanced tool-step planning", () => {
    const parsed = oneSourceFiveWaysSchema.parse({ source_path: "/project1/look/out1" });
    expect(parsed.goal).toBe("generate five distinct performance-ready variations");
    expect(parsed.intensity).toBe("balanced");
    expect(parsed.include_tool_steps).toBe(true);
  });

  it("returns exactly five deterministic remix directions with tool steps", async () => {
    const result = await oneSourceFiveWaysImpl(makeCtx(), {
      source_path: "/project1/look/out1",
      source_summary: "cyan wireframe tunnel with slow rotation",
      goal: "prepare a festival drop pack",
      intensity: "extreme",
      include_tool_steps: true,
    });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as {
      source_path: string;
      intensity: string;
      variations: Array<{ id: string; prompt: string; recommended_tools?: string[] }>;
    };
    expect(structured.source_path).toBe("/project1/look/out1");
    expect(structured.intensity).toBe("extreme");
    expect(structured.variations).toHaveLength(5);
    expect(new Set(structured.variations.map((variation) => variation.id)).size).toBe(5);
    expect(structured.variations[0]?.prompt).toContain("/project1/look/out1");
    expect(structured.variations.every((variation) => variation.recommended_tools?.length)).toBe(
      true,
    );
  });

  it("can omit tool steps for pure creative briefs", async () => {
    const result = await oneSourceFiveWaysImpl(makeCtx(), {
      source_path: "asset:look-a",
      goal: "make a compact prompt board",
      intensity: "subtle",
      include_tool_steps: false,
    });

    const structured = result.structuredContent as {
      variations: Array<{ recommended_tools?: string[]; checkpoints: string[] }>;
    };
    expect(structured.variations).toHaveLength(5);
    expect(
      structured.variations.every((variation) => variation.recommended_tools === undefined),
    ).toBe(true);
    expect(structured.variations.every((variation) => variation.checkpoints.length > 0)).toBe(true);
  });

  it("is registered read-only and local", () => {
    const calls: Array<{ name: string; options: { annotations?: Record<string, boolean> } }> = [];
    const fakeServer = {
      registerTool(name: string, options: { annotations?: Record<string, boolean> }) {
        calls.push({ name, options });
      },
    };
    registerOneSourceFiveWays(fakeServer as never, makeCtx());
    expect(calls[0]?.name).toBe("one_source_five_ways");
    expect(calls[0]?.options.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
  });
});
