import { describe, expect, it, vi } from "vitest";
import { findToolImpl } from "../../src/tools/layer3/findTool.js";
import type { ToolContext } from "../../src/tools/types.js";

function fakeTool(description: string, enabled = false, title?: string) {
  const tool = {
    title,
    description,
    enabled,
    enable: vi.fn(() => {
      tool.enabled = true;
    }),
  };
  return tool;
}

function ctxWith(tools: Record<string, ReturnType<typeof fakeTool>>): ToolContext {
  return { toolCatalog: new Map(Object.entries(tools)) } as unknown as ToolContext;
}

interface Output {
  matches: Array<{ name: string; title: string; summary: string; enabled: boolean }>;
  enabled: string[];
  unknown: string[];
  note?: string;
}

const output = (result: unknown): Output =>
  (result as { structuredContent: Output }).structuredContent;

describe("find_tool", () => {
  it("ranks a name match above a description mention", async () => {
    const ctx = ctxWith({
      apply_post_processing: fakeTool("Chains effects, including glitch."),
      create_glitch: fakeTool("Datamosh style corruption.", false, "Create glitch"),
    });
    const { matches } = output(await findToolImpl(ctx, { query: "glitch", limit: 8 }));
    expect(matches.map((m) => m.name)).toEqual(["create_glitch", "apply_post_processing"]);
  });

  it("matches regardless of case and accents", async () => {
    const ctx = ctxWith({ create_fluid_sim: fakeTool("Stable fluids.") });
    const { matches } = output(await findToolImpl(ctx, { query: "FLÚID", limit: 8 }));
    expect(matches.map((m) => m.name)).toEqual(["create_fluid_sim"]);
  });

  it("respects the limit and reports no match honestly", async () => {
    const ctx = ctxWith({
      a_noise: fakeTool("noise"),
      b_noise: fakeTool("noise"),
      c_noise: fakeTool("noise"),
    });
    expect(output(await findToolImpl(ctx, { query: "noise", limit: 2 })).matches).toHaveLength(2);
    expect(output(await findToolImpl(ctx, { query: "zzz", limit: 8 })).matches).toEqual([]);
  });

  it("summarizes to the first sentence", async () => {
    const ctx = ctxWith({ t_noise: fakeTool("Makes noise. Then a very long story.") });
    const { matches } = output(await findToolImpl(ctx, { query: "noise", limit: 8 }));
    expect(matches[0]?.summary).toBe("Makes noise.");
  });

  it("enables known tools once and reports unknown ones", async () => {
    const off = fakeTool("off");
    const on = fakeTool("on", true);
    const ctx = ctxWith({ off_tool: off, on_tool: on });
    const result = output(
      await findToolImpl(ctx, { enable: ["off_tool", "on_tool", "nope"], limit: 8 }),
    );
    expect(off.enable).toHaveBeenCalledOnce();
    expect(on.enable).not.toHaveBeenCalled();
    expect(result.enabled).toEqual(["off_tool", "on_tool"]);
    expect(result.unknown).toEqual(["nope"]);
    expect(result.note).toMatch(/TDMCP_TOOL_PROFILE=full/);
  });

  it("errors when given nothing to do", async () => {
    const result = await findToolImpl(ctxWith({}), { limit: 8 });
    expect(result.isError).toBe(true);
  });

  it("copes with a missing catalog", async () => {
    const ctx = {} as ToolContext;
    expect(output(await findToolImpl(ctx, { query: "x1", limit: 8 })).matches).toEqual([]);
    expect(output(await findToolImpl(ctx, { enable: ["x"], limit: 8 })).unknown).toEqual(["x"]);
  });
});
