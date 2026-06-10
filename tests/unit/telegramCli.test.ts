import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseTelegramArgs, runTelegram } from "../../src/cli/telegram.js";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import type { AgentEvent } from "../../src/llm/agent.js";
import type { ChatMessage, LlmClient } from "../../src/llm/client.js";
import type { LlmTool } from "../../src/llm/tools.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { TelegramBotClient } from "../../src/telegram/client.js";
import { TelegramCopilotService, type TelegramSender } from "../../src/telegram/copilot.js";
import type { ToolContext } from "../../src/tools/types.js";
import { loadConfig } from "../../src/utils/config.js";
import { silentLogger } from "../../src/utils/logger.js";

const originalExitCode = process.exitCode;

afterEach(() => {
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});

const makeCtx = (): ToolContext => ({
  client: new TouchDesignerClient({ baseUrl: "http://127.0.0.1:9", timeoutMs: 500 }),
  knowledge: new KnowledgeBase(),
  recipes: new RecipeLibrary(),
  logger: silentLogger,
});

function answeringTurn(answer: string, seen: { prompts: string[]; tools: string[][] }) {
  return vi.fn(async (_ctx, _client, messages: ChatMessage[], onEvent, opts) => {
    seen.prompts.push(String(messages.at(-1)?.content ?? ""));
    seen.tools.push(((opts?.tools ?? []) as LlmTool[]).map((tool) => tool.name));
    onEvent?.({ type: "answer", content: answer } as AgentEvent);
    return [...messages, { role: "assistant", content: answer }];
  }) as unknown as typeof import("../../src/llm/agent.js").runAgentTurn;
}

class RecordingSender implements TelegramSender {
  messages: Array<{ chatId: string | number; text: string }> = [];
  async sendMessage(chatId: string | number, text: string): Promise<void> {
    this.messages.push({ chatId, text });
  }
}

describe("parseTelegramArgs", () => {
  it("parses setup flags without accepting the bot token as an argv value", () => {
    const opts = parseTelegramArgs([
      "setup",
      "--config",
      "/tmp/tdmcp.json",
      "--profile",
      "studio",
      "--chat-id",
      "111",
      "--user-id",
      "5",
      "--token-stdin",
    ]);

    expect(opts.command).toBe("setup");
    expect(opts.configPath).toBe("/tmp/tdmcp.json");
    expect(opts.profile).toBe("studio");
    expect(opts.chatId).toBe("111");
    expect(opts.userId).toBe("5");
    expect(opts.tokenStdin).toBe(true);
  });

  it("parses local polling and config selection flags", () => {
    const opts = parseTelegramArgs([
      "--once",
      "--read-only",
      "--poll-timeout",
      "15",
      "--profile",
      "club",
      "--config",
      "/tmp/tdmcp.json",
      "--drop-pending-updates",
    ]);

    expect(opts.once).toBe(true);
    expect(opts.readOnly).toBe(true);
    expect(opts.pollTimeoutSec).toBe(15);
    expect(opts.profile).toBe("club");
    expect(opts.configPath).toBe("/tmp/tdmcp.json");
    expect(opts.dropPendingUpdates).toBe(true);
  });

  it("rejects invalid polling timeouts", () => {
    expect(() => parseTelegramArgs(["--poll-timeout", "0"])).toThrow(/poll-timeout/);
    expect(() => parseTelegramArgs(["--poll-timeout", "bad"])).toThrow(/poll-timeout/);
  });
});

describe("TelegramBotClient", () => {
  it("validates a token with getMe using the official token-test endpoint", async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method });
      return new Response(
        JSON.stringify({ ok: true, result: { id: 99, is_bot: true, username: "tdmcp_bot" } }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const client = new TelegramBotClient({ token: "secret-token", fetchImpl });

    const me = await client.getMe();

    expect(calls).toEqual([
      { url: "https://api.telegram.org/botsecret-token/getMe", method: "GET" },
    ]);
    expect(me.username).toBe("tdmcp_bot");
  });

  it("uses getUpdates offset/timeout and sends messages without exposing the token", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new TelegramBotClient({ token: "secret-token", fetchImpl });

    await client.getUpdates({ offset: 42, timeout: 15 });
    await client.sendMessage(123, "hello");

    expect(calls[0]?.url).toContain("/botsecret-token/getUpdates");
    expect(calls[0]?.body).toMatchObject({
      offset: 42,
      timeout: 15,
      allowed_updates: ["message"],
    });
    expect(calls[1]?.url).toContain("/botsecret-token/sendMessage");
    expect(calls[1]?.body).toMatchObject({ chat_id: 123, text: "hello" });
  });

  it("keeps the HTTP timeout above the requested long-poll timeout", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new TelegramBotClient({ token: "secret-token", fetchImpl });

    await client.getUpdates({ timeout: 60 });

    expect(
      setTimeoutSpy.mock.calls.some(([, delay]) => typeof delay === "number" && delay >= 65_000),
    ).toBe(true);
  });
});

describe("TelegramCopilotService", () => {
  it("rejects non-allowlisted updates before they reach the LLM", async () => {
    const sender = new RecordingSender();
    const seen = { prompts: [], tools: [] as string[][] };
    const turn = answeringTurn("never", seen);
    const service = new TelegramCopilotService({
      ctx: makeCtx(),
      client: {} as LlmClient,
      sender,
      runAgentTurn: turn,
      allowedChatIds: new Set(["111"]),
      allowedUserIds: new Set(),
      defaultTier: "safe",
    });

    await service.handleUpdate({
      update_id: 1,
      message: { chat: { id: 999 }, from: { id: 5 }, text: "inspect /project1" },
    });

    expect(turn).not.toHaveBeenCalled();
    expect(sender.messages.at(-1)?.text).toContain("not authorized");
  });

  it("runs allowlisted plain prompts immediately in safe mode", async () => {
    const sender = new RecordingSender();
    const seen: { prompts: string[]; tools: string[][] } = { prompts: [], tools: [] };
    const service = new TelegramCopilotService({
      ctx: makeCtx(),
      client: {} as LlmClient,
      sender,
      runAgentTurn: answeringTurn("Project looks clean.", seen),
      allowedChatIds: new Set(["111"]),
      allowedUserIds: new Set(),
      defaultTier: "safe",
    });

    await service.handleUpdate({
      update_id: 1,
      message: { chat: { id: 111 }, from: { id: 5 }, text: "inspect /project1" },
    });

    expect(seen.prompts).toEqual(["inspect /project1"]);
    expect(seen.tools).toHaveLength(1);
    expect(seen.tools.at(0)).toContain("get_td_nodes");
    expect(seen.tools.at(0)).not.toContain("create_td_node");
    expect(sender.messages.at(-1)?.text).toContain("Project looks clean.");
  });

  it("requires /approve before running prompts in standard mode", async () => {
    const sender = new RecordingSender();
    const seen: { prompts: string[]; tools: string[][] } = { prompts: [], tools: [] };
    const service = new TelegramCopilotService({
      ctx: makeCtx(),
      client: {} as LlmClient,
      sender,
      runAgentTurn: answeringTurn("Created it.", seen),
      allowedChatIds: new Set(["111"]),
      allowedUserIds: new Set(),
      defaultTier: "safe",
    });
    const base = { update_id: 1, message: { chat: { id: 111 }, from: { id: 5 } } };

    await service.handleUpdate({ ...base, message: { ...base.message, text: "/standard" } });
    await service.handleUpdate({
      ...base,
      update_id: 2,
      message: { ...base.message, text: "create a noise TOP" },
    });
    expect(seen.prompts).toEqual([]);
    expect(sender.messages.at(-1)?.text).toContain("/approve");

    await service.handleUpdate({
      ...base,
      update_id: 3,
      message: { ...base.message, text: "/approve" },
    });

    expect(seen.prompts).toEqual(["create a noise TOP"]);
    expect(seen.tools).toHaveLength(1);
    expect(seen.tools.at(0)).toContain("create_td_node");
    expect(sender.messages.at(-1)?.text).toContain("Created it.");
  });
});

describe("runTelegram", () => {
  it("runs setup from stdin, validates the token, and writes the selected config file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tdmcp-telegram-setup-"));
    const configPath = join(dir, "config.json");
    let stdout = "";
    let stderr = "";
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith("/getMe") && init?.method === "GET") {
        return new Response(
          JSON.stringify({ ok: true, result: { id: 99, is_bot: true, username: "tdmcp_bot" } }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected request: ${String(url)}`);
    }) as unknown as typeof fetch;

    try {
      await runTelegram(
        ["setup", "--config", configPath, "--chat-id", "111", "--user-id", "5", "--token-stdin"],
        {
          createBotClient: (cfg) =>
            new TelegramBotClient({ token: cfg.telegramBotToken ?? "", fetchImpl }),
          readStdin: async () => "secret-token\n",
          writeStdout: (chunk) => {
            stdout += chunk;
          },
          writeStderr: (chunk) => {
            stderr += chunk;
          },
        },
      );

      const saved = JSON.parse(readFileSync(configPath, "utf8"));
      expect(saved).toMatchObject({
        telegramBotToken: "secret-token",
        telegramAllowedChats: ["111"],
        telegramAllowedUsers: ["5"],
        telegramDefaultTier: "safe",
      });
      expect(stdout).toContain("@tdmcp_bot");
      expect(stdout).toContain("Saved Telegram config");
      expect(stdout).not.toContain("secret-token");
      expect(stderr).toBe("");
      expect(process.exitCode).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to start without a bot token or any allowlist", async () => {
    let stderr = "";
    await runTelegram(["--once"], {
      loadConfig: () => loadConfig({}),
      writeStderr: (chunk) => {
        stderr += chunk;
      },
      writeStdout: () => {},
    });

    expect(stderr).toContain("TDMCP_TELEGRAM_BOT_TOKEN");
    expect(process.exitCode).toBe(2);
  });
});
