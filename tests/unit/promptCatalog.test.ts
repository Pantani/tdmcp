import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { PROMPT_CATALOG } from "../../src/prompts/catalog.js";
import { registerAllPrompts } from "../../src/prompts/index.js";

describe("prompt catalog", () => {
  it("contains every Wave 5 prompt name", () => {
    const names = PROMPT_CATALOG.map((entry) => entry.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "fix_reactivity",
        "recover_show",
        "auto_vj_director",
        "color_story",
        "lyric_show",
        "setlist_planner",
        "visual_ab_compare",
        "motion_critique",
        "explain_param",
      ]),
    );
  });

  it("registers the Wave 5 prompts", () => {
    const names: string[] = [];
    const server = {
      registerPrompt(name: string) {
        names.push(name);
      },
    } as unknown as McpServer;
    registerAllPrompts(server, {} as never);
    expect(names).toEqual(expect.arrayContaining(PROMPT_CATALOG.map((entry) => entry.name)));
  });
});
