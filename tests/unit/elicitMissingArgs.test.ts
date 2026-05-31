import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import type {
  CompleteOptions,
  CompleteResult,
  LlmClientLike,
  MultimodalMessage,
} from "../../src/llm/client.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  elicitMissingArgsImpl,
  elicitMissingArgsSchema,
} from "../../src/tools/layer3/elicitMissingArgs.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

interface FakeRegEntry {
  inputSchema?: z.ZodRawShape;
  description?: string;
  title?: string;
}

function makeServer(reg: Record<string, FakeRegEntry>): McpServer {
  return { _registeredTools: reg } as unknown as McpServer;
}

function makeCtx(opts: {
  reg?: Record<string, FakeRegEntry>;
  llm?: LlmClientLike;
  noServer?: boolean;
}): ToolContext & { server?: McpServer } {
  const ctx: ToolContext & { server?: McpServer } = {
    client: new TouchDesignerClient({ baseUrl: "http://127.0.0.1:9980", timeoutMs: 2000 }),
    knowledge: new KnowledgeBase(),
    recipes: new RecipeLibrary(),
    logger: silentLogger,
  };
  if (!opts.noServer) ctx.server = makeServer(opts.reg ?? {});
  if (opts.llm) ctx.llm = opts.llm;
  return ctx;
}

function reportOf(result: { structuredContent?: unknown }): {
  tool_name: string;
  filled: Record<string, unknown>;
  proposed_args: Record<string, unknown>;
  missing: string[];
  source: "llm" | "offline" | "none-needed";
  warnings: string[];
} {
  return result.structuredContent as ReturnType<typeof reportOf>;
}

function fakeLlm(
  textOrFn: string | ((msgs: MultimodalMessage[], opts?: CompleteOptions) => string),
): LlmClientLike & { calls: Array<{ messages: MultimodalMessage[]; opts?: CompleteOptions }> } {
  const calls: Array<{ messages: MultimodalMessage[]; opts?: CompleteOptions }> = [];
  return {
    calls,
    async complete(messages, opts): Promise<CompleteResult> {
      calls.push({ messages, opts });
      const text = typeof textOrFn === "function" ? textOrFn(messages, opts) : textOrFn;
      return { text };
    },
    async chatStream() {
      throw new Error("chatStream not used");
    },
  };
}

const defaults = { temperature: 0.1, max_fields: 16 };

describe("elicit_missing_args", () => {
  it("none-needed when all required fields are supplied", async () => {
    const reg = {
      foo: {
        inputSchema: { a: z.string(), b: z.number().default(2) },
        description: "test tool",
      },
    };
    const llm = fakeLlm("{}");
    const ctx = makeCtx({ reg, llm });
    const out = await elicitMissingArgsImpl(ctx, {
      tool_name: "foo",
      partial_args: { a: "x" },
      ...defaults,
    });
    expect(out.isError).toBeUndefined();
    const r = reportOf(out);
    expect(r.source).toBe("none-needed");
    expect(r.missing).toEqual([]);
    expect(llm.calls.length).toBe(0);
  });

  it("LLM elicits required fields and validates", async () => {
    const reg = {
      audio: {
        inputSchema: { node_path: z.string(), gain: z.number() },
        description: "audio reactive",
      },
    };
    const llm = fakeLlm('{"node_path":"/project1/audio","gain":0.8}');
    const ctx = makeCtx({ reg, llm });
    const out = await elicitMissingArgsImpl(ctx, {
      tool_name: "audio",
      partial_args: {},
      context: "make it loud",
      ...defaults,
    });
    const r = reportOf(out);
    expect(r.source).toBe("llm");
    expect(r.filled.node_path).toBe("/project1/audio");
    expect(r.proposed_args.gain).toBe(0.8);
    expect(r.missing).toEqual([]);
    expect(llm.calls.length).toBe(1);
    // path-like warning fires
    expect(r.warnings.some((w) => w.includes("node path"))).toBe(true);
  });

  it("grammar fallback when LLM returns non-JSON", async () => {
    const reg = {
      foo: { inputSchema: { a: z.string() }, description: "" },
    };
    const llm = fakeLlm("sure! here you go: not json");
    const ctx = makeCtx({ reg, llm });
    const out = await elicitMissingArgsImpl(ctx, {
      tool_name: "foo",
      partial_args: {},
      ...defaults,
    });
    const r = reportOf(out);
    expect(r.filled.a).toBeNull();
    expect(r.missing).toContain("a");
    expect(r.warnings.some((w) => w.includes("non-JSON"))).toBe(true);
  });

  it("offline path when ctx.llm is undefined", async () => {
    const reg = { foo: { inputSchema: { a: z.string() } } };
    const ctx = makeCtx({ reg });
    const out = await elicitMissingArgsImpl(ctx, {
      tool_name: "foo",
      partial_args: {},
      ...defaults,
    });
    const r = reportOf(out);
    expect(r.source).toBe("offline");
    expect(r.filled.a).toBeNull();
    expect(r.warnings.some((w) => w.includes("no LLM"))).toBe(true);
  });

  it("schema-validation feedback puts bad fields back into missing", async () => {
    const reg = { foo: { inputSchema: { count: z.number() } } };
    const llm = fakeLlm('{"count":"not a number"}');
    const ctx = makeCtx({ reg, llm });
    const out = await elicitMissingArgsImpl(ctx, {
      tool_name: "foo",
      partial_args: {},
      ...defaults,
    });
    const r = reportOf(out);
    expect(r.missing).toContain("count");
    expect(r.warnings.some((w) => w.toLowerCase().includes("schema"))).toBe(true);
  });

  it("unknown tool → error result", async () => {
    const ctx = makeCtx({ reg: {} });
    const out = await elicitMissingArgsImpl(ctx, {
      tool_name: "does_not_exist",
      partial_args: {},
      ...defaults,
    });
    expect(out.isError).toBe(true);
  });

  it("no server in context → friendly error", async () => {
    const ctx = makeCtx({ noServer: true });
    const out = await elicitMissingArgsImpl(ctx, {
      tool_name: "foo",
      partial_args: {},
      ...defaults,
    });
    expect(out.isError).toBe(true);
  });

  it("ZodDefault fields are not required", async () => {
    const reg = {
      foo: {
        inputSchema: {
          a: z.string(),
          mode: z.enum(["a", "b"]).default("a"),
        },
      },
    };
    const ctx = makeCtx({ reg });
    const out = await elicitMissingArgsImpl(ctx, {
      tool_name: "foo",
      partial_args: { a: "x" },
      ...defaults,
    });
    const r = reportOf(out);
    expect(r.source).toBe("none-needed");
    expect(r.missing).toEqual([]);
  });

  it("truncates very long context and warns", async () => {
    const reg = { foo: { inputSchema: { a: z.string() } } };
    const llm = fakeLlm('{"a":"y"}');
    const ctx = makeCtx({ reg, llm });
    const longCtx = "x".repeat(10_000);
    const out = await elicitMissingArgsImpl(ctx, {
      tool_name: "foo",
      partial_args: {},
      context: longCtx,
      ...defaults,
    });
    const r = reportOf(out);
    expect(r.warnings.some((w) => w.includes("truncated"))).toBe(true);
    const call = llm.calls[0];
    expect(call).toBeDefined();
    const userMsg = call?.messages[0]?.content;
    const text = typeof userMsg === "string" ? userMsg : "";
    // Prompt body wraps the truncated context; total prompt should not contain the 10k-char block
    expect(text.length).toBeLessThan(6000);
  });

  it("schema.parse defaults work via the Zod schema", () => {
    const parsed = elicitMissingArgsSchema.parse({ tool_name: "foo" });
    expect(parsed.temperature).toBe(0.1);
    expect(parsed.max_fields).toBe(16);
    expect(parsed.partial_args).toEqual({});
  });

  it("never throws on LLM errors", async () => {
    const reg = { foo: { inputSchema: { a: z.string() } } };
    const llm: LlmClientLike = {
      async complete() {
        throw new Error("boom");
      },
      async chatStream() {
        throw new Error("nope");
      },
    };
    const ctx = makeCtx({ reg, llm });
    const out = await elicitMissingArgsImpl(ctx, {
      tool_name: "foo",
      partial_args: {},
      ...defaults,
    });
    expect(out.isError).toBeUndefined();
    const r = reportOf(out);
    expect(r.warnings.some((w) => w.includes("boom"))).toBe(true);
  });
});

// Silence unused import lint
void vi;
