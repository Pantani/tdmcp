import {
  collectPromptCatalog,
  type PromptCatalogEntry,
} from "../resources/promptCatalogResource.js";
import type { ToolContext } from "../tools/types.js";
import { DEFAULT_LLM_MAX_STEPS, MAX_LLM_MAX_STEPS } from "../utils/config.js";
import type { ChatMessage, LlmClient } from "./client.js";
import { dispatchTool, LLM_TOOLS, type LlmTool, toOpenAITools } from "./tools.js";

/** Streamed to the UI as the turn progresses so the chat feels alive. */
export type AgentEvent =
  | { type: "token"; text: string }
  | { type: "tool"; name: string; status: "start"; args: string }
  | { type: "tool"; name: string; status: "done"; ok: boolean; summary: string }
  | { type: "answer"; content: string }
  | { type: "suggestion"; kind: "handoff"; message: string }
  | { type: "error"; message: string };

/**
 * How many tool calls may fail back-to-back before the copilot suggests handing the
 * task to Claude/Codex. A local dead-end (a small model looping on failing calls) is
 * the strongest signal it is out of its depth; two consecutive failures is enough to
 * offer help without nagging on a single transient error.
 */
const HANDOFF_FAILURE_THRESHOLD = 2;

/** Non-intrusive one-liner nudging the user toward the /handoff escape hatch. */
const HANDOFF_SUGGESTION =
  "This looks stuck — the local copilot keeps hitting tool errors. If you want, hand this " +
  "off to Claude or Codex (the /handoff button, or `POST /handoff`): they drive the same " +
  "TouchDesigner bridge with the full toolset and can pick up where this left off.";

export interface RunOptions {
  /** Abort an in-flight turn (cancel button / client disconnect). */
  signal?: AbortSignal;
  /** Tool set to expose this turn. Defaults to the full curated registry. */
  tools?: LlmTool[];
  /** Maximum model/tool loop iterations for this turn. Defaults to the historic budget. */
  maxSteps?: number;
}

const MAX_PROMPT_CATALOG_ENTRIES = 40;

const BASE_PROMPT = `You are the tdmcp local copilot — a small, fast model embedded in TouchDesigner through the tdmcp bridge.

You handle SIMPLE tasks only:
- inspecting the project (list/find nodes, read parameters, check errors, map topology),
- creating, wiring, deleting and parameterizing INDIVIDUAL operators,
- answering questions from the TouchDesigner Python knowledge base.

Rules:
- Use your tools. Never invent operator types or node paths — if unsure, inspect first (get_td_nodes / find_td_nodes).
- The default parent COMP is /project1.
- Keep actions minimal and report plainly what you did.
- If a request needs a whole SYSTEM or multi-step orchestration (e.g. an audio-reactive visual, a feedback network, a generative-art or particle system, a full show), DO NOT attempt it. Tell the user it is better handled by Claude or Codex — the high-power agents that drive this same TouchDesigner project with the full toolset.
- Reply in the user's language.`;

const READ_ONLY_NOTE = `\n- READ-ONLY MODE is on: you can inspect freely but cannot create, modify, wire or delete anything. If the user asks for a change, explain what you would do and suggest they turn off read-only mode or hand off to Claude/Codex.`;

const CREATIVE_NOTE = `\n- CREATIVE MODE is on: you may use the selected Layer-1 generators for small complete looks. Still work probe-first: inspect, build one focused system, check errors, capture a preview, and keep the user informed. Do not use raw Python or destructive restore/delete workflows.`;

function promptCatalogNote(prompts: PromptCatalogEntry[]): string {
  if (prompts.length === 0) return "";
  const lines = prompts.slice(0, MAX_PROMPT_CATALOG_ENTRIES).map((prompt) => {
    const summary = (prompt.summary || prompt.title).replace(/\s+/g, " ").trim();
    const args = prompt.args.length > 0 ? ` (args: ${prompt.args.join(", ")})` : "";
    return `- ${prompt.name}: ${summary}${args}`;
  });
  return `\n\nRegistered MCP prompts from tdmcp://prompts:
${lines.join("\n")}

You cannot invoke these MCP prompts directly from this local chat, but you should know they exist. When the user's request matches one, name the prompt and explain that Claude/Codex or an MCP client can invoke it.`;
}

function systemPrompt(
  readOnly: boolean,
  creative: boolean,
  prompts: PromptCatalogEntry[] = [],
): string {
  const prompt = BASE_PROMPT + promptCatalogNote(prompts);
  if (readOnly) return prompt + READ_ONLY_NOTE;
  return creative ? prompt + CREATIVE_NOTE : prompt;
}

/** Re-inject an authoritative system prompt for the current tier (drops any stale one). */
function ensureSystem(
  history: ChatMessage[],
  readOnly: boolean,
  creative: boolean,
  prompts: PromptCatalogEntry[],
): ChatMessage[] {
  const rest = history.filter((m) => m.role !== "system");
  return [{ role: "system", content: systemPrompt(readOnly, creative, prompts) }, ...rest];
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.message === "cancelled");
}

/**
 * Runs one user turn to completion: repeatedly streams a model response, executes
 * any tool calls it requests, and feeds results back until the model produces a
 * plain-text answer (or the step budget runs out). Text tokens stream out via
 * `emit` as they arrive; the full updated message list is returned so the caller
 * can persist conversation state.
 */
export async function runAgentTurn(
  ctx: ToolContext,
  client: LlmClient,
  history: ChatMessage[],
  emit: (event: AgentEvent) => void,
  opts: RunOptions = {},
): Promise<ChatMessage[]> {
  const toolset = opts.tools ?? LLM_TOOLS;
  const readOnly = !toolset.some((tool) => tool.mutates);
  const creative = toolset.some((tool) => tool.name === "create_feedback_network");
  const prompts = collectPromptCatalog(ctx);
  const messages = ensureSystem(history, readOnly, creative, prompts);
  const tools = toOpenAITools(toolset);
  const maxSteps =
    opts.maxSteps !== undefined && Number.isFinite(opts.maxSteps)
      ? Math.min(MAX_LLM_MAX_STEPS, Math.max(1, Math.trunc(opts.maxSteps)))
      : DEFAULT_LLM_MAX_STEPS;

  // Dead-end detection: count tool failures that land back-to-back across steps and
  // offer a handoff to Claude/Codex once the local model is clearly looping on errors.
  // The suggestion fires at most once per turn so it never becomes noise.
  let consecutiveFailures = 0;
  let handoffSuggested = false;

  for (let step = 0; step < maxSteps; step++) {
    if (opts.signal?.aborted) {
      emit({ type: "error", message: "cancelled" });
      return messages;
    }

    let assistant: ChatMessage;
    try {
      assistant = await client.chatStream(messages, tools, {
        signal: opts.signal,
        onToken: (text) => emit({ type: "token", text }),
      });
    } catch (err) {
      if (isAbort(err)) {
        emit({ type: "error", message: "cancelled" });
        return messages;
      }
      const message = (err as Error).message;
      emit({ type: "error", message });
      messages.push({ role: "assistant", content: `(failed to reach the LLM: ${message})` });
      return messages;
    }

    messages.push(assistant);

    const calls = assistant.tool_calls ?? [];
    if (calls.length === 0) {
      emit({ type: "answer", content: assistant.content ?? "" });
      return messages;
    }

    for (const call of calls) {
      emit({
        type: "tool",
        name: call.function.name,
        status: "start",
        args: call.function.arguments,
      });
      const outcome = await dispatchTool(ctx, call.function.name, call.function.arguments, toolset);
      emit({
        type: "tool",
        name: call.function.name,
        status: "done",
        ok: outcome.ok,
        summary: outcome.summary,
      });
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        name: call.function.name,
        content: outcome.payload,
      });

      // Track back-to-back tool failures; a successful call resets the streak.
      consecutiveFailures = outcome.ok ? 0 : consecutiveFailures + 1;
      if (!handoffSuggested && consecutiveFailures >= HANDOFF_FAILURE_THRESHOLD) {
        handoffSuggested = true;
        emit({ type: "suggestion", kind: "handoff", message: HANDOFF_SUGGESTION });
      }
    }
  }

  const content =
    "(stopped after the maximum number of steps — try a simpler request, or hand this to Claude/Codex.)";
  emit({ type: "answer", content });
  messages.push({ role: "assistant", content });
  return messages;
}
