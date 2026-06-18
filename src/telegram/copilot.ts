import type { AgentEvent, runAgentTurn as runAgentTurnFn } from "../llm/agent.js";
import type { ChatMessage, LlmClient } from "../llm/client.js";
import { resolveTools, type ToolTier } from "../llm/tools.js";
import type { ToolContext } from "../tools/types.js";
import type { TelegramUpdate } from "./client.js";

export interface TelegramSender {
  sendMessage(chatId: number | string, text: string): Promise<void>;
}

interface ChatState {
  tier: ToolTier;
  history: ChatMessage[];
  pending?: PendingPrompt;
}

interface PendingPrompt {
  prompt: string;
  tier: ToolTier;
  createdAt: number;
}

export interface TelegramCopilotServiceOptions {
  ctx: ToolContext;
  client: LlmClient;
  sender: TelegramSender;
  runAgentTurn: typeof runAgentTurnFn;
  allowedChatIds: Set<string>;
  allowedUserIds: Set<string>;
  defaultTier: ToolTier;
  confirmTimeoutMs?: number;
  maxHistoryMessages?: number;
  now?: () => number;
}

const DEFAULT_CONFIRM_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_HISTORY_MESSAGES = 24;
const MAX_TELEGRAM_TEXT = 3900;

function keyOf(value: number | string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return String(value);
}

function commandOf(text: string): { command: string; rest: string } | undefined {
  if (!text.startsWith("/")) return undefined;
  const [raw = "", ...rest] = text.split(/\s+/);
  const command = raw.split("@")[0]?.toLowerCase();
  if (!command) return undefined;
  return { command, rest: rest.join(" ").trim() };
}

function trimHistory(messages: ChatMessage[], max: number): ChatMessage[] {
  return messages.filter((m) => m.role !== "system").slice(-max);
}

export class TelegramCopilotService {
  private readonly states = new Map<string, ChatState>();
  private readonly active = new Map<string, AbortController>();
  private readonly confirmTimeoutMs: number;
  private readonly maxHistoryMessages: number;
  private readonly now: () => number;

  constructor(private readonly opts: TelegramCopilotServiceOptions) {
    this.confirmTimeoutMs = opts.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS;
    this.maxHistoryMessages = opts.maxHistoryMessages ?? DEFAULT_MAX_HISTORY_MESSAGES;
    this.now = opts.now ?? (() => Date.now());
  }

  async handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    const text = message?.text?.trim();
    const chatId = message?.chat.id;
    const chatKey = keyOf(chatId);
    if (!message || !text || chatId === undefined || chatKey === undefined) return;

    if (!this.isAllowed(chatKey, keyOf(message.from?.id))) {
      await this.send(chatId, "tdmcp telegram: not authorized.");
      return;
    }

    const state = this.stateFor(chatKey);
    const parsed = commandOf(text);
    if (parsed) {
      await this.handleCommand(chatId, chatKey, state, parsed.command, parsed.rest);
      return;
    }

    await this.handlePrompt(chatId, chatKey, state, text);
  }

  private isAllowed(chatId: string, userId?: string): boolean {
    const hasChatRules = this.opts.allowedChatIds.size > 0;
    const hasUserRules = this.opts.allowedUserIds.size > 0;
    if (!hasChatRules && !hasUserRules) return false;
    if (hasChatRules && !this.opts.allowedChatIds.has(chatId)) return false;
    if (hasUserRules && (!userId || !this.opts.allowedUserIds.has(userId))) return false;
    return true;
  }

  private stateFor(chatKey: string): ChatState {
    let state = this.states.get(chatKey);
    if (!state) {
      state = { tier: this.opts.defaultTier, history: [] };
      this.states.set(chatKey, state);
    }
    return state;
  }

  private async handleCommand(
    chatId: number | string,
    chatKey: string,
    state: ChatState,
    command: string,
    rest: string,
  ): Promise<void> {
    if (command === "/help" || command === "/start") {
      await this.send(
        chatId,
        "tdmcp telegram commands: /status, /safe, /standard, /creative, /approve, /cancel, /panic.",
      );
      return;
    }
    if (command === "/status") {
      await this.send(
        chatId,
        `tdmcp telegram: tier=${state.tier}; pending=${state.pending ? "yes" : "no"}; active=${
          this.active.has(chatKey) ? "yes" : "no"
        }.`,
      );
      return;
    }
    if (command === "/safe" || command === "/standard" || command === "/creative") {
      state.tier = command.slice(1) as ToolTier;
      state.pending = undefined;
      const suffix =
        state.tier === "safe"
          ? "Read-only prompts run immediately."
          : `Non-safe prompts are staged first. Send /approve to execute the next ${state.tier} prompt.`;
      await this.send(chatId, `tdmcp telegram: tier set to ${state.tier}. ${suffix}`);
      return;
    }
    if (command === "/approve") {
      await this.approve(chatId, chatKey, state);
      return;
    }
    if (command === "/cancel") {
      state.pending = undefined;
      this.active.get(chatKey)?.abort();
      await this.send(chatId, "tdmcp telegram: cancelled pending/running work for this chat.");
      return;
    }
    if (command === "/panic") {
      await this.send(
        chatId,
        "tdmcp telegram: panic is not executed remotely in this MVP. Use a trusted local shell: tdmcp-agent panic on.",
      );
      return;
    }
    await this.send(chatId, `tdmcp telegram: unknown command ${command}${rest ? ` ${rest}` : ""}.`);
  }

  private async handlePrompt(
    chatId: number | string,
    chatKey: string,
    state: ChatState,
    prompt: string,
  ): Promise<void> {
    if (state.tier !== "safe") {
      state.pending = { prompt, tier: state.tier, createdAt: this.now() };
      await this.send(
        chatId,
        `tdmcp telegram: staged ${state.tier} request. Send /approve within ${Math.round(
          this.confirmTimeoutMs / 1000,
        )}s to execute it, or /cancel.`,
      );
      return;
    }
    await this.executePrompt(chatId, chatKey, state, prompt, "safe");
  }

  private async approve(chatId: number | string, chatKey: string, state: ChatState): Promise<void> {
    const pending = state.pending;
    if (!pending) {
      await this.send(chatId, "tdmcp telegram: nothing pending approval.");
      return;
    }
    state.pending = undefined;
    if (this.now() - pending.createdAt > this.confirmTimeoutMs) {
      await this.send(chatId, "tdmcp telegram: pending request expired; send it again.");
      return;
    }
    await this.executePrompt(chatId, chatKey, state, pending.prompt, pending.tier);
  }

  private async executePrompt(
    chatId: number | string,
    chatKey: string,
    state: ChatState,
    prompt: string,
    tier: ToolTier,
  ): Promise<void> {
    if (this.active.has(chatKey)) {
      await this.send(chatId, "tdmcp telegram: a turn is already running. Send /cancel first.");
      return;
    }

    const controller = new AbortController();
    this.active.set(chatKey, controller);
    let answer = "";
    let error = "";
    const toolEvents: string[] = [];
    try {
      const history: ChatMessage[] = [...state.history, { role: "user", content: prompt }];
      const messages = await this.opts.runAgentTurn(
        this.opts.ctx,
        this.opts.client,
        history,
        (event) => {
          this.recordEvent(
            event,
            toolEvents,
            (next) => {
              answer = next;
            },
            (next) => {
              error = next;
            },
          );
        },
        {
          tools: resolveTools(tier, { projectRag: this.opts.ctx.projectRag !== undefined }),
          signal: controller.signal,
        },
      );
      state.history = trimHistory(messages, this.maxHistoryMessages);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      this.active.delete(chatKey);
    }

    for (const line of toolEvents.slice(0, 6)) await this.send(chatId, line);
    if (answer.trim()) {
      await this.send(chatId, answer.trim());
      return;
    }
    if (error.trim()) {
      await this.send(chatId, `tdmcp telegram: ${error.trim()}`);
      return;
    }
    await this.send(chatId, "tdmcp telegram: no response.");
  }

  private recordEvent(
    event: AgentEvent,
    toolEvents: string[],
    setAnswer: (value: string) => void,
    setError: (value: string) => void,
  ): void {
    if (event.type === "answer") setAnswer(event.content);
    else if (event.type === "error") setError(event.message);
    else if (event.type === "tool" && event.status === "done") {
      toolEvents.push(
        `tdmcp tool ${event.name}: ${event.ok ? "ok" : "failed"}${
          event.summary ? ` — ${event.summary}` : ""
        }`,
      );
    }
  }

  private async send(chatId: number | string, text: string): Promise<void> {
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += MAX_TELEGRAM_TEXT) {
      chunks.push(text.slice(i, i + MAX_TELEGRAM_TEXT));
    }
    for (const chunk of chunks.length ? chunks : [""]) {
      await this.opts.sender.sendMessage(chatId, chunk);
    }
  }
}
