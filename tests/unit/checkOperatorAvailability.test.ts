import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { TdApiError } from "../../src/td-client/types.js";
import { checkOperatorAvailabilityImpl } from "../../src/tools/layer3/checkOperatorAvailability.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

const LIVE = {
  optypes: ["noiseTOP", "nullTOP", "baseCOMP", "artnetDAT"],
  families: { TOP: ["noiseTOP", "nullTOP"], COMP: ["baseCOMP"], DAT: ["artnetDAT"] },
  count: 4,
  td_version: "099",
  build: "2025.32820",
};

const KB = [
  {
    slug: "noise_top",
    name: "Noise TOP",
    displayName: "Noise TOP",
    category: "TOP",
    subcategory: "",
    summary: "",
    keywords: [],
  },
  {
    slug: "null_top",
    name: "Null TOP",
    displayName: "Null TOP",
    category: "TOP",
    subcategory: "",
    summary: "",
    keywords: [],
  },
  {
    slug: "art_net_dat",
    name: "Art-Net DAT",
    displayName: "Art-Net DAT",
    category: "DAT",
    subcategory: "",
    summary: "",
    keywords: [],
  },
  {
    slug: "wrnchai_chop",
    name: "WrnchAI CHOP",
    displayName: "WrnchAI CHOP",
    category: "CHOP",
    subcategory: "",
    summary: "",
    keywords: [],
  },
];

function fakeCtx(getOpTypes: ReturnType<typeof vi.fn>): ToolContext {
  return {
    client: { getOpTypes },
    knowledge: { listOperators: () => KB },
    logger: silentLogger,
  } as unknown as ToolContext;
}

function payload(result: CallToolResult): Record<string, unknown> {
  const text = result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  const match = /```json\n([\s\S]*?)\n```/.exec(text);
  if (!match) throw new Error(`no json block in result: ${text}`);
  return JSON.parse(match[1] as string);
}

describe("checkOperatorAvailabilityImpl", () => {
  it("reconciles the whole KB, flagging deprecated operators (alnum-normalized match)", async () => {
    const getOpTypes = vi.fn(async () => LIVE);
    const result = await checkOperatorAvailabilityImpl(fakeCtx(getOpTypes), {
      include_kb_gap: false,
    });
    expect(result.isError).toBeFalsy();
    const data = payload(result);
    // "Art-Net DAT" normalizes to "artnetdat" which matches the live "artnetDAT".
    expect(data.checked).toBe(4);
    expect(data.createable_count).toBe(3);
    // Only WrnchAI CHOP has no live optype -> deprecated.
    expect(data.deprecated).toEqual([{ name: "WrnchAI CHOP", category: "CHOP" }]);
  });

  it("reports the live-only KB gap when include_kb_gap is set", async () => {
    const getOpTypes = vi.fn(async () => LIVE);
    const result = await checkOperatorAvailabilityImpl(fakeCtx(getOpTypes), {
      include_kb_gap: true,
    });
    const data = payload(result);
    // baseCOMP is live but not documented in this KB fixture.
    expect(data.kb_gap).toEqual(["baseCOMP"]);
  });

  it("checks a single operator by display name and reports createable", async () => {
    const getOpTypes = vi.fn(async () => LIVE);
    const result = await checkOperatorAvailabilityImpl(fakeCtx(getOpTypes), {
      operator: "Noise TOP",
      include_kb_gap: false,
    });
    const data = payload(result);
    expect(Array.isArray(data.operators)).toBe(true);
    const ops = data.operators as Array<{ createable: boolean; optype: string }>;
    expect(ops[0]?.createable).toBe(true);
    expect(ops[0]?.optype).toBe("noiseTOP");
  });

  it("falls back to a direct live check for an operator absent from the KB", async () => {
    const getOpTypes = vi.fn(async () => LIVE);
    const result = await checkOperatorAvailabilityImpl(fakeCtx(getOpTypes), {
      operator: "baseCOMP",
      include_kb_gap: false,
    });
    const data = payload(result);
    expect(data.in_knowledge_base).toBe(false);
    expect(data.createable).toBe(true);
    expect(data.optype).toBe("baseCOMP");
  });

  it("returns a friendly error result when the bridge call fails", async () => {
    const getOpTypes = vi.fn(async () => {
      throw new TdApiError("Cannot reach TouchDesigner.");
    });
    const result = await checkOperatorAvailabilityImpl(fakeCtx(getOpTypes), {
      include_kb_gap: false,
    });
    expect(result.isError).toBe(true);
  });
});
