import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { isLocalOllama } from "../../src/cli/chat.js";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { type AgentEvent, runAgentTurn } from "../../src/llm/agent.js";
import {
  applySettings,
  ChatAccumulator,
  type ChatMessage,
  LlmClient,
  type LlmConfig,
} from "../../src/llm/client.js";
import { buildHandoffPrompt } from "../../src/llm/handoff.js";
import { createMutationDescriptor } from "../../src/llm/mutationVerification.js";
import { resolveRequestedTier } from "../../src/llm/server.js";
import {
  CREATIVE_TOOLS,
  dispatchTool,
  LLM_TOOLS,
  resolveTools,
  toOpenAITools,
} from "../../src/llm/tools.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import type { ToolContext } from "../../src/tools/types.js";
import { MAX_LLM_MAX_STEPS } from "../../src/utils/config.js";
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
    expect(names).toContain("diagnose_hardware_environment");
    expect(names).toContain("get_td_nodes");
    expect(names).toContain("create_td_node");
    expect(names).toContain("connect_nodes");
    expect(names).toContain("manage_project_brief");
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
    expect(byName.diagnose_hardware_environment).toBe(false);
    expect(byName.get_td_nodes).toBe(false);
    expect(byName.create_td_node).toBe(true);
    expect(byName.delete_td_node).toBe(true);
    expect(byName.manage_project_brief).toBe(true);
  });

  it("the safe tier exposes only read-only tools", () => {
    const safe = resolveTools("safe");
    expect(safe.length).toBeGreaterThan(0);
    expect(safe.every((t) => !t.mutates)).toBe(true);
    expect(safe.map((t) => t.name)).not.toContain("create_td_node");
    expect(safe.map((t) => t.name)).not.toContain("manage_project_brief");
    expect(resolveTools("standard").map((t) => t.name)).toContain("manage_project_brief");
    expect(resolveTools("standard")).toHaveLength(LLM_TOOLS.length);
  });

  it("applies calibration as a maximum tier and fails closed when enforce has no decision", () => {
    const verifiedStandard = {
      effectiveTier: "standard" as const,
      policyReason: "enforce_verified_cap" as const,
    };

    expect(resolveTools("creative", { calibration: verifiedStandard })).toHaveLength(
      LLM_TOOLS.length,
    );
    expect(
      resolveTools("safe", { calibration: verifiedStandard }).every((tool) => !tool.mutates),
    ).toBe(true);
    expect(
      resolveTools("creative", { calibrationMode: "enforce" }).every((tool) => !tool.mutates),
    ).toBe(true);
    expect(resolveTools("creative", { calibrationMode: "recommend" })).toHaveLength(
      LLM_TOOLS.length + CREATIVE_TOOLS.length,
    );
  });

  it("exposes the new read-only KB tools to every tier", () => {
    const names = LLM_TOOLS.map((t) => t.name);
    expect(names).toContain("search_operators");
    expect(names).toContain("list_recipes");
    expect(names).toContain("suggest_operator_chain");
    expect(names).toContain("validate_operator_chain");
    expect(names).toContain("draft_recipe_from_operator_chain");
    expect(names).toContain("get_technique_detail");
    expect(names).toContain("draft_recipe_from_technique");
    expect(names).toContain("get_tutorial");
    expect(names).toContain("draft_recipe_from_tutorial");
    expect(names).toContain("plan_td_version_migration");
    const byName = Object.fromEntries(LLM_TOOLS.map((t) => [t.name, t.mutates]));
    expect(byName.search_operators).toBe(false);
    expect(byName.list_recipes).toBe(false);
    expect(byName.suggest_operator_chain).toBe(false);
    expect(byName.validate_operator_chain).toBe(false);
    expect(byName.draft_recipe_from_operator_chain).toBe(false);
    expect(byName.get_technique_detail).toBe(false);
    expect(byName.draft_recipe_from_technique).toBe(false);
    expect(byName.get_tutorial).toBe(false);
    expect(byName.draft_recipe_from_tutorial).toBe(false);
    expect(byName.plan_td_version_migration).toBe(false);
  });

  it("the creative tier adds the curated Layer-1 generators on top of standard", () => {
    const creative = resolveTools("creative");
    expect(creative.length).toBe(LLM_TOOLS.length + CREATIVE_TOOLS.length);
    const names = creative.map((t) => t.name);
    expect(names).toContain("create_generative_art");
    expect(names).toContain("create_feedback_network");
    expect(names).toContain("create_audio_reactive");
    // Generators are mutating, and standard must NOT expose them.
    expect(CREATIVE_TOOLS.every((t) => t.mutates)).toBe(true);
    expect(resolveTools("standard").map((t) => t.name)).not.toContain("create_generative_art");
    // safe stays read-only even though creative exists.
    expect(resolveTools("safe").some((t) => t.mutates)).toBe(false);
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
  it("grounds one turn before the latest user message and never persists the evidence", async () => {
    const getEditorContext = vi.fn().mockResolvedValue({
      project: { name: "show.toe", folder: "/private", save_version: 1, save_build: 2 },
      touchdesigner: { version: "2025", build: "32820" },
      perform_mode: false,
      ui_available: true,
      panes: [{ type: "NETWORKEDITOR", active: true, name: "pane1" }],
      active_network_editor: {
        pane: { type: "NETWORKEDITOR", name: "pane1" },
        owner: "/project1/scene",
        current: "/project1/scene/noise1",
        selected: ["/project1/scene/noise1"],
        rollover_operator: null,
        rollover_parameter: null,
        viewport: { x: 10, y: 20, zoom: 0.8 },
      },
      warnings: [],
    });
    const ctx = { ...makeCtx(), client: { getEditorContext } } as unknown as ToolContext;
    let seenMessages: ChatMessage[] = [];
    let seenTools: Array<{ function: { name: string } }> = [];
    const events: AgentEvent[] = [];
    const model = {
      chatStream: async (messages: ChatMessage[], tools: Array<{ function: { name: string } }>) => {
        seenMessages = [...messages];
        seenTools = tools;
        return { role: "assistant", content: "ok" };
      },
    } as unknown as LlmClient;

    const returned = await runAgentTurn(
      ctx,
      model,
      [{ role: "user", content: "inspect this node" }],
      (event) => events.push(event),
      { tools: resolveTools("safe") },
    );

    expect(getEditorContext).toHaveBeenCalledOnce();
    expect(seenMessages.at(-3)?.content).toContain("tdmcp_untrusted_editor_context_json");
    expect(seenMessages.at(-2)?.content).toContain("UNTRUSTED_PROJECT_BRIEF");
    expect(seenMessages.at(-1)?.content).toBe("inspect this node");
    expect(JSON.stringify(returned)).not.toContain("tdmcp_untrusted_editor_context_json");
    expect(JSON.stringify(returned)).not.toContain("UNTRUSTED_PROJECT_BRIEF");
    expect(events.filter((event) => event.type === "receipt")).toHaveLength(1);
    expect(seenTools.map((tool) => tool.function.name)).toContain("get_editor_context");
    expect(seenTools.map((tool) => tool.function.name)).toContain("invoke_registered_prompt");
    expect(seenMessages[0]?.content).not.toContain("default parent COMP is /project1");
  });

  it("renders a registered prompt only as a tool result", async () => {
    const model = scriptedClient([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "p1",
            type: "function",
            function: {
              name: "invoke_registered_prompt",
              arguments: '{"name":"debug_network","arguments":{"root_path":"/project1"}}',
            },
          },
        ],
      },
      { role: "assistant", content: "I will follow the bounded playbook." },
    ]);

    const messages = await runAgentTurn(
      makeCtx(),
      model,
      [{ role: "user", content: "use the debug prompt" }],
      () => {},
      { tools: resolveTools("safe") },
    );

    const rendered = messages.find(
      (message) => message.role === "tool" && message.name === "invoke_registered_prompt",
    );
    expect(rendered?.content).toContain('"status":"rendered"');
    expect(messages.filter((message) => message.role === "system")).toHaveLength(1);
    expect(messages[0]?.content).not.toContain("Debug the TouchDesigner network at /project1");
  });

  it("attaches PASS verification before the next model step", async () => {
    const mutationTool = {
      name: "test_create",
      description: "synthetic local mutation",
      schema: z.object({ type: z.string() }),
      mutates: true,
      mutation: createMutationDescriptor(),
      run: vi.fn(async () => ({
        content: [{ type: "text" as const, text: "Created test node." }],
        structuredContent: { node: { path: "/project1/noise1", parameter_warnings: [] } },
      })),
    };
    const bridge = {
      getEditorContext: vi.fn().mockResolvedValue({
        project: {},
        touchdesigner: {},
        perform_mode: false,
        ui_available: true,
        panes: [],
        active_network_editor: {
          pane: {},
          owner: "/project1",
          current: "/project1/noise1",
          selected: [],
          rollover_operator: null,
          rollover_parameter: null,
          viewport: null,
        },
        warnings: [],
      }),
      getNode: vi.fn().mockResolvedValue({
        path: "/project1/noise1",
        type: "noiseTOP",
        parameters: {},
      }),
      getNetworkErrors: vi.fn().mockResolvedValue({ errors: [] }),
      getNetworkTopology: vi.fn(),
      sampleGrid: vi.fn(),
      getInfo: vi.fn(),
      getNodes: vi.fn(),
    };
    const ctx = { ...makeCtx(), client: bridge } as unknown as ToolContext;
    const turns: ChatMessage[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "m1",
            type: "function",
            function: { name: "test_create", arguments: '{"type":"noiseTOP"}' },
          },
        ],
      },
      { role: "assistant", content: "verified" },
    ];
    let callIndex = 0;
    let secondStep: ChatMessage[] = [];
    const model = {
      chatStream: async (messages: ChatMessage[]) => {
        if (callIndex === 1) secondStep = [...messages];
        return turns[callIndex++] as ChatMessage;
      },
    } as unknown as LlmClient;
    const events: AgentEvent[] = [];

    await runAgentTurn(
      ctx,
      model,
      [{ role: "user", content: "create it" }],
      (event) => events.push(event),
      { tools: [mutationTool] },
    );

    const done = events.find(
      (event): event is Extract<AgentEvent, { type: "tool"; status: "done" }> =>
        event.type === "tool" && event.status === "done",
    );
    expect(done?.verification?.status).toBe("PASS");
    const toolResult = secondStep.find((message) => message.role === "tool");
    expect(toolResult?.content).toContain('"status":"PASS"');
    expect(bridge.getNode).toHaveBeenCalledOnce();
    expect(mutationTool.run).toHaveBeenCalledOnce();
  });

  it("returns bounded validation recovery evidence without dispatching the tool", async () => {
    const run = vi.fn();
    const tool = {
      name: "strict_read",
      description: "strict synthetic read",
      schema: z.object({ path: z.string() }),
      mutates: false,
      run,
    };
    const model = scriptedClient([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "r1",
            type: "function",
            function: { name: "strict_read", arguments: '{"path":42}' },
          },
        ],
      },
      { role: "assistant", content: "corrected later" },
    ]);
    const events: AgentEvent[] = [];

    const messages = await runAgentTurn(
      makeCtx(),
      model,
      [{ role: "user", content: "inspect" }],
      (event) => events.push(event),
      { tools: [tool] },
    );

    expect(run).not.toHaveBeenCalled();
    const done = events.find(
      (event): event is Extract<AgentEvent, { type: "tool"; status: "done" }> =>
        event.type === "tool" && event.status === "done",
    );
    expect(done?.recovery).toMatchObject({
      category: "invalid_args",
      outcome: "recovered",
      mutationRetry: "blocked",
    });
    expect(messages.find((message) => message.role === "tool")?.content).toContain(
      '"mutationRetry":"blocked"',
    );
  });

  it("passes only bounded validated parameter metadata into a real menu recovery", async () => {
    const getParameterMenu = vi.fn().mockResolvedValue({ names: ["add", "multiply"] });
    const bridge = {
      getEditorContext: vi.fn().mockRejectedValue(new Error("headless")),
      getParameterMenu,
    };
    const ctx = { ...makeCtx(), client: bridge } as unknown as ToolContext;
    const tool = {
      name: "strict_menu_update",
      description: "synthetic menu update",
      schema: z.object({
        path: z.string(),
        parameters: z.record(z.string(), z.unknown()),
      }),
      mutates: false,
      run: vi.fn(async () => ({
        isError: true,
        content: [{ type: "text" as const, text: "invalid menu" }],
        structuredContent: { error: { api_code: "invalid_menu_value" } },
      })),
    };
    const model = scriptedClient([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "menu-1",
            type: "function",
            function: {
              name: tool.name,
              arguments: '{"path":"/project1/comp1","parameters":{"operation":"secret-choice"}}',
            },
          },
        ],
      },
      { role: "assistant", content: "Use one of the live choices." },
    ]);
    const events: AgentEvent[] = [];

    await runAgentTurn(
      ctx,
      model,
      [{ role: "user", content: "set operation" }],
      (event) => events.push(event),
      { tools: [tool] },
    );

    expect(getParameterMenu).toHaveBeenCalledWith("/project1/comp1", "operation", {
      timeoutMs: 1000,
      retryGet: false,
    });
    const done = events.find(
      (event): event is Extract<AgentEvent, { type: "tool"; status: "done" }> =>
        event.type === "tool" && event.status === "done",
    );
    expect(done?.recovery).toMatchObject({
      category: "menu_invalid",
      action: "probe_menu",
      outcome: "recovered",
      evidence: { parameter: "operation", choices: ["add", "multiply"] },
    });
    expect(JSON.stringify(done?.recovery)).not.toContain("secret-choice");
  });

  it("keeps recovered evidence probes in the failure streak until a real success", async () => {
    const run = vi.fn();
    const tool = {
      name: "strict_streak_read",
      description: "synthetic strict read",
      schema: z.object({ path: z.string() }),
      mutates: false,
      run,
    };
    const invalidCall = (id: string): ChatMessage => ({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id,
          type: "function",
          function: { name: tool.name, arguments: '{"path":42}' },
        },
      ],
    });
    const events: AgentEvent[] = [];

    await runAgentTurn(
      makeCtx(),
      scriptedClient([
        invalidCall("recover-1"),
        invalidCall("recover-2"),
        { role: "assistant", content: "handoff" },
      ]),
      [{ role: "user", content: "inspect twice" }],
      (event) => events.push(event),
      { tools: [tool] },
    );

    expect(run).not.toHaveBeenCalled();
    expect(
      events.filter(
        (event) =>
          event.type === "tool" &&
          event.status === "done" &&
          event.recovery?.outcome === "recovered",
      ),
    ).toHaveLength(2);
    expect(events.filter((event) => event.type === "suggestion")).toHaveLength(1);
  });

  it("resets the failure streak only after a genuinely successful tool outcome", async () => {
    const tool = {
      name: "strict_reset_read",
      description: "synthetic strict read",
      schema: z.object({ path: z.string() }),
      mutates: false,
      run: vi.fn(async () => ({ content: [{ type: "text" as const, text: "ok" }] })),
    };
    const call = (id: string, path: string | number): ChatMessage => ({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id,
          type: "function",
          function: { name: tool.name, arguments: JSON.stringify({ path }) },
        },
      ],
    });
    const events: AgentEvent[] = [];

    await runAgentTurn(
      makeCtx(),
      scriptedClient([
        call("reset-fail-1", 42),
        call("reset-success", "/project1"),
        call("reset-fail-2", 42),
        { role: "assistant", content: "done" },
      ]),
      [{ role: "user", content: "inspect" }],
      (event) => events.push(event),
      { tools: [tool] },
    );

    expect(tool.run).toHaveBeenCalledOnce();
    expect(events.filter((event) => event.type === "suggestion")).toHaveLength(0);
  });

  it("bypasses recovery for emergency-equivalent names without overmatching failover", async () => {
    const emergencyNames = [
      "panic_status",
      "safety_blackout",
      "emergency_stop",
      "e_stop",
      "estop",
      "kill_switch",
      "master_kill",
      "show_fail_safe",
      "stop_all",
      "all_stop",
    ];
    const ordinaryName = "create_show_failover";
    const getInfo = vi.fn().mockResolvedValue({ build: "2025.32820" });
    const ctx = {
      ...makeCtx(),
      client: {
        getEditorContext: vi.fn().mockRejectedValue(new Error("headless")),
        getInfo,
      },
    } as unknown as ToolContext;
    const failureResult = async () => ({
      isError: true,
      content: [{ type: "text" as const, text: "stale" }],
      structuredContent: { error: { api_code: "bridge_stale" } },
    });
    const tools = [...emergencyNames, ordinaryName].map((name) => ({
      name,
      description: "synthetic safety failure",
      schema: z.object({}),
      mutates: false,
      run: vi.fn(failureResult),
    }));
    const events: AgentEvent[] = [];

    await runAgentTurn(
      ctx,
      scriptedClient([
        {
          role: "assistant",
          content: null,
          tool_calls: tools.map((tool, index) => ({
            id: `safety-${index}`,
            type: "function" as const,
            function: { name: tool.name, arguments: "{}" },
          })),
        },
        { role: "assistant", content: "stopped safely" },
      ]),
      [{ role: "user", content: "stop" }],
      (event) => events.push(event),
      { tools },
    );

    const done = events.filter(
      (event): event is Extract<AgentEvent, { type: "tool"; status: "done" }> =>
        event.type === "tool" && event.status === "done",
    );
    for (const name of emergencyNames) {
      expect(done.find((event) => event.name === name)?.recovery).toBeUndefined();
    }
    expect(done.find((event) => event.name === ordinaryName)?.recovery?.outcome).toBe("recovered");
    expect(getInfo).toHaveBeenCalledOnce();
  });

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
    expect(events).toContainEqual({
      type: "answer",
      content: "There are several TOP classes.",
    });
    expect(events.at(-1)?.type).toBe("receipt");
  });

  it("suggests a handoff after consecutive tool failures, once per turn", async () => {
    // The ctx bridge points at a discard port, so any bridge-touching tool call fails.
    // Two failing get_td_nodes calls in a row is a dead-end → one handoff suggestion.
    const nodesCall = (id: string): ChatMessage => ({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id,
          type: "function",
          function: { name: "get_td_nodes", arguments: '{"parent_path":"/project1"}' },
        },
      ],
    });
    const client = scriptedClient([
      nodesCall("c1"),
      nodesCall("c2"),
      nodesCall("c3"),
      { role: "assistant", content: "I keep failing." },
    ]);

    const events: AgentEvent[] = [];
    await runAgentTurn(makeCtx(), client, [{ role: "user", content: "list the nodes" }], (e) =>
      events.push(e),
    );

    const suggestions = events.filter((e) => e.type === "suggestion");
    expect(suggestions).toHaveLength(1);
    const suggestion = suggestions[0];
    expect(suggestion).toMatchObject({ type: "suggestion", kind: "handoff" });
    expect((suggestion as { message: string }).message.toLowerCase()).toContain("handoff");
  });

  it("does not suggest a handoff when tool calls succeed", async () => {
    // get_td_classes is a pure offline KB tool — it succeeds without the bridge.
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
      { role: "assistant", content: "Here are the TOP classes." },
    ]);

    const events: AgentEvent[] = [];
    await runAgentTurn(makeCtx(), client, [{ role: "user", content: "top classes?" }], (e) =>
      events.push(e),
    );
    expect(events.some((e) => e.type === "suggestion")).toBe(false);
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
    expect(events[0]).toEqual({ type: "error", message: "cancelled" });
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      type: "receipt",
      receipt: { terminal_status: "cancelled", persistence: "off" },
    });
  });

  it("stops a tool batch after cancellation and finalizes as cancelled", async () => {
    const controller = new AbortController();
    const first = vi.fn(async () => {
      controller.abort();
      return { content: [{ type: "text" as const, text: "first complete" }] };
    });
    const second = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "must not run" }],
    }));
    const tools = [
      { name: "first", description: "first", schema: z.object({}), mutates: false, run: first },
      { name: "second", description: "second", schema: z.object({}), mutates: false, run: second },
    ];
    const events: AgentEvent[] = [];

    await runAgentTurn(
      makeCtx(),
      scriptedClient([
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "first-call", type: "function", function: { name: "first", arguments: "{}" } },
            {
              id: "second-call",
              type: "function",
              function: { name: "second", arguments: "{}" },
            },
          ],
        },
      ]),
      [{ role: "user", content: "run then cancel" }],
      (event) => events.push(event),
      { tools, signal: controller.signal, maxSteps: 1 },
    );

    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
    expect(
      events.filter((event) => event.type === "tool" && event.status === "start"),
    ).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      type: "receipt",
      receipt: { terminal_status: "cancelled", persistence: "off" },
    });
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

  it("respects a configured maximum step budget", async () => {
    let calls = 0;
    const client = {
      chatStream: async () => {
        calls += 1;
        return {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: `c${calls}`,
              type: "function",
              function: { name: "get_td_classes", arguments: "{}" },
            },
          ],
        };
      },
    } as unknown as LlmClient;

    const events: AgentEvent[] = [];
    const messages = await runAgentTurn(
      makeCtx(),
      client,
      [{ role: "user", content: "keep inspecting" }],
      (e) => events.push(e),
      { maxSteps: 2 },
    );

    expect(calls).toBe(2);
    expect(messages.at(-1)?.content).toContain("maximum number of steps");
    expect(events).toContainEqual({ type: "answer", content: messages.at(-1)?.content });
    expect(events.at(-1)).toMatchObject({
      type: "receipt",
      receipt: { terminal_status: "max_steps" },
    });
  });

  it("caps programmatic maximum step overrides", async () => {
    let calls = 0;
    const client = {
      chatStream: async () => {
        calls += 1;
        return {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: `c${calls}`,
              type: "function",
              function: { name: "get_td_classes", arguments: "{}" },
            },
          ],
        };
      },
    } as unknown as LlmClient;

    await runAgentTurn(
      makeCtx(),
      client,
      [{ role: "user", content: "keep inspecting forever" }],
      () => {},
      { maxSteps: 10_000 },
    );

    expect(calls).toBe(MAX_LLM_MAX_STEPS);
  });

  it("injects the registered MCP prompt catalog into the system prompt", async () => {
    let seen: ChatMessage[] = [];
    const client = {
      chatStream: async (messages: ChatMessage[]) => {
        seen = messages;
        return { role: "assistant", content: "ok" };
      },
    } as unknown as LlmClient;

    await runAgentTurn(
      makeCtx(),
      client,
      [{ role: "user", content: "which prompts can guide a visual?" }],
      () => {},
    );

    const system = seen[0]?.content ?? "";
    expect(system).toContain("tdmcp://prompts");
    expect(system).toContain("visual_artist_mode");
    expect(system).toContain("debug_network");
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

  it("passes the configured streaming temperature to the LLM endpoint", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const client = new LlmClient({
        llmBaseUrl: "http://llm.test/v1",
        llmModel: "test-model",
        llmApiKey: undefined,
        llmTemperature: 0.85,
      });

      const message = await client.chatStream([], []);

      expect(message.content).toBe("ok");
      expect(bodies[0]?.temperature).toBe(0.85);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("local copilot — configured tier", () => {
  it("uses the configured default tier when a request omits a tier", () => {
    expect(resolveRequestedTier(undefined, "creative")).toBe("creative");
    expect(resolveRequestedTier("", "safe")).toBe("safe");
  });

  it("lets an explicit request tier override the configured default", () => {
    expect(resolveRequestedTier("safe", "creative")).toBe("safe");
    expect(resolveRequestedTier("creative", "safe")).toBe("creative");
    expect(resolveRequestedTier("standard", "creative")).toBe("standard");
  });

  it("falls back to the configured default for unknown request tiers", () => {
    expect(resolveRequestedTier("unsafe", "safe")).toBe("safe");
  });
});

describe("local copilot — Ollama auto-start gating", () => {
  it("recognizes the local Ollama default endpoint (which it may auto-start)", () => {
    expect(isLocalOllama("http://127.0.0.1:11434/v1")).toBe(true);
    expect(isLocalOllama("http://localhost:11434/v1")).toBe(true);
  });

  it("does NOT treat remote or non-default endpoints as local Ollama", () => {
    expect(isLocalOllama("https://api.openai.com/v1")).toBe(false);
    expect(isLocalOllama("http://127.0.0.1:1234/v1")).toBe(false); // e.g. LM Studio
    expect(isLocalOllama("http://192.168.1.50:11434/v1")).toBe(false); // remote host
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
