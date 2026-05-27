import { describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { type AgentEvent, runAgentTurn } from "../../src/llm/agent.js";
import {
  applySettings,
  ChatAccumulator,
  type ChatMessage,
  type LlmClient,
  type LlmConfig,
} from "../../src/llm/client.js";
import { buildHandoffPrompt } from "../../src/llm/handoff.js";
import { dispatchTool, LLM_TOOLS, resolveTools, toOpenAITools } from "../../src/llm/tools.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

const makeCtx = (): ToolContext => ({
  // Port 9 (discard) — these tests only exercise offline tools, so it is never hit.
  client: new TouchDesignerClient({ baseUrl: "http://127.0.0.1:9", timeoutMs: 500 }),
  knowledge: new KnowledgeBase(),
  recipes: new RecipeLibrary(),
  logger: silentLogger,
});

/** A scripted LLM that streams each queued assistant turn's text, then returns it. */
function scriptedClient(turns: ChatMessage[]): LlmClient {
  let i = 0;
  return {
    chatStream: async (
      _messages: ChatMessage[],
      _tools: unknown,
      opts?: { onToken?: (t: string) => void },
    ) => {
      const turn = turns[i++] ?? { role: "assistant", content: "(no more turns)" };
      if (turn.content && opts?.onToken) opts.onToken(turn.content);
      return turn;
    },
  } as unknown as LlmClient;
}

describe("local copilot — curated tool registry", () => {
  it("exposes the inspection/CRUD subset and withholds Layer-1 + raw Python", () => {
    const names = LLM_TOOLS.map((t) => t.name);
    expect(names).toContain("get_td_info");
    expect(names).toContain("get_td_nodes");
    expect(names).toContain("create_td_node");
    expect(names).toContain("connect_nodes");
    // The whole point: no system generators, no escape hatches.
    expect(names).not.toContain("create_visual_system");
    expect(names).not.toContain("create_feedback_network");
    expect(names).not.toContain("execute_python_script");
    expect(names).not.toContain("exec_node_method");
    // Names are unique.
    expect(new Set(names).size).toBe(names.length);
  });

  it("flags mutating vs read-only tools", () => {
    const byName = Object.fromEntries(LLM_TOOLS.map((t) => [t.name, t.mutates]));
    expect(byName.get_td_info).toBe(false);
    expect(byName.get_td_nodes).toBe(false);
    expect(byName.create_td_node).toBe(true);
    expect(byName.delete_td_node).toBe(true);
  });

  it("the safe tier exposes only read-only tools", () => {
    const safe = resolveTools("safe");
    expect(safe.length).toBeGreaterThan(0);
    expect(safe.every((t) => !t.mutates)).toBe(true);
    expect(safe.map((t) => t.name)).not.toContain("create_td_node");
    expect(resolveTools("standard")).toHaveLength(LLM_TOOLS.length);
  });

  it("converts tools to OpenAI function specs with object parameters", () => {
    const specs = toOpenAITools();
    expect(specs).toHaveLength(LLM_TOOLS.length);
    for (const spec of specs) {
      expect(spec.type).toBe("function");
      expect(typeof spec.function.name).toBe("string");
      expect(spec.function.description.length).toBeGreaterThan(0);
      expect((spec.function.parameters as { type?: string }).type).toBe("object");
    }
  });

  it("dispatches an offline tool and reports success", async () => {
    const outcome = await dispatchTool(makeCtx(), "get_td_classes", '{"filter":"top"}');
    expect(outcome.ok).toBe(true);
    expect(outcome.summary).toMatch(/class/i);
  });

  it("rejects unknown tools and invalid args without throwing", async () => {
    const unknown = await dispatchTool(makeCtx(), "nope", "{}");
    expect(unknown.ok).toBe(false);
    expect(unknown.summary).toMatch(/unknown tool/i);

    const badJson = await dispatchTool(makeCtx(), "get_td_classes", "{not json");
    expect(badJson.ok).toBe(false);
  });
});

describe("local copilot — streaming accumulator", () => {
  it("accumulates content tokens and forwards each to onToken", () => {
    const tokens: string[] = [];
    const acc = new ChatAccumulator((t) => tokens.push(t));
    acc.push({ choices: [{ delta: { content: "Hel" } }] });
    acc.push({ choices: [{ delta: { content: "lo" } }] });
    const msg = acc.finish();
    expect(msg.content).toBe("Hello");
    expect(tokens).toEqual(["Hel", "lo"]);
    expect(msg.tool_calls).toBeUndefined();
  });

  it("reassembles a tool call from fragmented deltas", () => {
    const acc = new ChatAccumulator();
    acc.push({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: "c1", function: { name: "get_td_nodes", arguments: '{"par' } },
            ],
          },
        },
      ],
    });
    acc.push({
      choices: [
        {
          delta: { tool_calls: [{ index: 0, function: { arguments: 'ent_path":"/project1"}' } }] },
        },
      ],
    });
    const msg = acc.finish();
    expect(msg.content).toBeNull();
    expect(msg.tool_calls).toHaveLength(1);
    expect(msg.tool_calls?.[0]?.function.name).toBe("get_td_nodes");
    expect(msg.tool_calls?.[0]?.function.arguments).toBe('{"parent_path":"/project1"}');
  });
});

describe("local copilot — agent loop", () => {
  it("runs a tool call, streams tokens, then returns the final answer", async () => {
    const client = scriptedClient([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "get_td_classes", arguments: '{"filter":"top"}' },
          },
        ],
      },
      { role: "assistant", content: "There are several TOP classes." },
    ]);

    const events: AgentEvent[] = [];
    const messages = await runAgentTurn(
      makeCtx(),
      client,
      [{ role: "user", content: "what TOP classes are there?" }],
      (e) => events.push(e),
    );

    // A system prompt is injected, and the tool result is threaded back to the model.
    expect(messages[0]?.role).toBe("system");
    expect(messages.some((m) => m.role === "tool" && m.name === "get_td_classes")).toBe(true);
    expect(messages.at(-1)?.content).toBe("There are several TOP classes.");

    // The UI sees the tool run, the answer streamed as a token, then finalized.
    expect(events).toContainEqual({
      type: "tool",
      name: "get_td_classes",
      status: "start",
      args: '{"filter":"top"}',
    });
    expect(events.some((e) => e.type === "tool" && e.status === "done" && e.ok)).toBe(true);
    expect(events).toContainEqual({ type: "token", text: "There are several TOP classes." });
    expect(events.at(-1)).toEqual({ type: "answer", content: "There are several TOP classes." });
  });

  it("surfaces an LLM transport error as an error event without throwing", async () => {
    const failing = {
      chatStream: async () => {
        throw new Error("connection refused");
      },
    } as unknown as LlmClient;

    const events: AgentEvent[] = [];
    await runAgentTurn(makeCtx(), failing, [{ role: "user", content: "hi" }], (e) =>
      events.push(e),
    );
    expect(events).toContainEqual({ type: "error", message: "connection refused" });
  });

  it("stops immediately when the abort signal is already tripped", async () => {
    const ac = new AbortController();
    ac.abort();
    const events: AgentEvent[] = [];
    await runAgentTurn(
      makeCtx(),
      scriptedClient([{ role: "assistant", content: "hi" }]),
      [{ role: "user", content: "hi" }],
      (e) => events.push(e),
      { signal: ac.signal },
    );
    expect(events).toEqual([{ type: "error", message: "cancelled" }]);
  });

  it("refuses a mutating tool call when running in the safe tier", async () => {
    // Model (mis)fires create_td_node; safe tier must not have it available.
    const client = scriptedClient([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: {
              name: "create_td_node",
              arguments: '{"parent_path":"/project1","type":"noiseTOP"}',
            },
          },
        ],
      },
      { role: "assistant", content: "I can't create nodes in read-only mode." },
    ]);

    const events: AgentEvent[] = [];
    await runAgentTurn(
      makeCtx(),
      client,
      [{ role: "user", content: "make a noise top" }],
      (e) => events.push(e),
      { tools: resolveTools("safe") },
    );

    // The tool runs through dispatch but is rejected as unknown (not in the safe set).
    expect(events.some((e) => e.type === "tool" && e.status === "done" && !e.ok)).toBe(true);
  });
});

describe("local copilot — live settings", () => {
  const base: LlmConfig = {
    llmBaseUrl: "http://127.0.0.1:11434/v1",
    llmModel: "qwen2.5:7b",
    llmApiKey: undefined,
  };

  it("updates only the fields provided, ignoring blanks", () => {
    expect(applySettings(base, { model: "llama3.2:3b" }).llmModel).toBe("llama3.2:3b");
    expect(applySettings(base, { model: "  " }).llmModel).toBe("qwen2.5:7b");
    const moved = applySettings(base, { baseUrl: "https://api.example.com/v1" });
    expect(moved.llmBaseUrl).toBe("https://api.example.com/v1");
    expect(moved.llmModel).toBe("qwen2.5:7b");
  });

  it("sets the api key on a value and clears it on empty string", () => {
    expect(applySettings(base, { apiKey: "sk-123" }).llmApiKey).toBe("sk-123");
    const withKey: LlmConfig = { ...base, llmApiKey: "sk-123" };
    expect(applySettings(withKey, { apiKey: "" }).llmApiKey).toBeUndefined();
    expect(applySettings(withKey, {}).llmApiKey).toBe("sk-123");
  });
});

describe("local copilot — handoff", () => {
  it("builds a paste-ready prompt capturing the goal and transcript", () => {
    const prompt = buildHandoffPrompt([
      { role: "system", content: "ignored" },
      { role: "user", content: "build an audio-reactive feedback system" },
      { role: "assistant", content: "That's a full system — better handled by Claude/Codex." },
    ]);
    expect(prompt).toContain("build an audio-reactive feedback system");
    expect(prompt).toContain("same bridge");
    expect(prompt).toContain("Local copilot:");
    // The system message is internal and must not leak into the handoff.
    expect(prompt).not.toContain("ignored");
  });
});
