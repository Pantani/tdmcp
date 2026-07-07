import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  it("parses tier/setup options and rejects extra setup positionals", () => {
    const opts = parseTelegramArgs([
      "--tier",
      "standard",
      "--creative",
      "setup",
      "--setup-timeout",
      "120",
      "--yes",
    ]);

    expect(opts.command).toBe("setup");
    expect(opts.tier).toBe("standard");
    expect(opts.creative).toBe(true);
    expect(opts.setupTimeoutSec).toBe(120);
    expect(opts.yes).toBe(true);
    expect(() => parseTelegramArgs(["setup", "extra"])).toThrow(/does not take positional/);
  });

  it("rejects invalid polling timeouts", () => {
    expect(() => parseTelegramArgs(["--poll-timeout", "0"])).toThrow(/poll-timeout/);
    expect(() => parseTelegramArgs(["--poll-timeout", "bad"])).toThrow(/poll-timeout/);
  });

  it("rejects invalid setup timeouts and tiers", () => {
    expect(() => parseTelegramArgs(["setup", "--setup-timeout", "0"])).toThrow(/setup-timeout/);
    expect(() => parseTelegramArgs(["setup", "--setup-timeout", "bad"])).toThrow(/setup-timeout/);
    expect(() => parseTelegramArgs(["--tier", "unsafe"])).toThrow(/--tier/);
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

  it("redacts the bot token from transport error messages", async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      throw new Error(`fetch failed: connect ECONNREFUSED for ${String(url)}`);
    }) as unknown as typeof fetch;
    const client = new TelegramBotClient({ token: "secret-token", fetchImpl });

    const error = await client.getMe().then(
      () => undefined,
      (err: unknown) => err as Error,
    );

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).not.toContain("secret-token");
    expect(error?.message).toContain("/bot[REDACTED]/getMe");
    expect(error?.message).toContain("Telegram Bot API getMe request failed");
    expect(error?.message).toContain("ECONNREFUSED");
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
  it("prints command help without loading runtime config", async () => {
    let stdout = "";
    await runTelegram(["--help"], {
      loadConfig: () => {
        throw new Error("help must not load config");
      },
      writeStdout: (chunk) => {
        stdout += chunk;
      },
    });

    expect(stdout).toContain("tdmcp telegram");
    expect(stdout).toContain("--drop-pending-updates");
  });

  it("prints setup help for the setup subcommand", async () => {
    let stdout = "";
    await runTelegram(["setup", "--help"], {
      writeStdout: (chunk) => {
        stdout += chunk;
      },
    });

    expect(stdout).toContain("tdmcp telegram setup");
    expect(stdout).toContain("--setup-timeout");
  });

  it("reports parser errors with usage and exit code 2", async () => {
    let stderr = "";
    await runTelegram(["bogus"], {
      writeStderr: (chunk) => {
        stderr += chunk;
      },
    });

    expect(stderr).toContain('unknown telegram subcommand "bogus"');
    expect(stderr).toContain("Usage:");
    expect(process.exitCode).toBe(2);
  });

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

  it("discovers a chat id during setup when --chat-id is omitted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tdmcp-telegram-discover-"));
    const configPath = join(dir, "config.json");
    let stdout = "";
    const bot = {
      getMe: vi.fn(async () => ({ id: 42, is_bot: true, username: "tdmcp_bot" })),
      deleteWebhook: vi.fn(async () => ({ ok: true })),
      getUpdates: vi.fn(async () => [
        { update_id: 7, message: { chat: { id: 222 }, from: { id: 9 }, text: "hello" } },
      ]),
    } as unknown as TelegramBotClient;
    const answers = ["", "yes"];

    try {
      await runTelegram(["setup", "--config", configPath, "--token-stdin"], {
        createBotClient: () => bot,
        readStdin: async () => "secret-token\n",
        readLine: async () => answers.shift() ?? "",
        writeStdout: (chunk) => {
          stdout += chunk;
        },
      });

      const saved = JSON.parse(readFileSync(configPath, "utf8"));
      expect(saved.telegramAllowedChats).toEqual(["222"]);
      expect(saved.telegramAllowedUsers).toEqual(["9"]);
      expect(bot.deleteWebhook).toHaveBeenCalledWith(false);
      expect(bot.getUpdates).toHaveBeenCalledWith({ timeout: 30 });
      expect(stdout).toContain("Send any message to @tdmcp_bot");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses an existing profile token without overwriting its default tier", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tdmcp-telegram-profile-"));
    const configPath = join(dir, "config.json");
    const originalToken = process.env.TDMCP_TELEGRAM_BOT_TOKEN;
    delete process.env.TDMCP_TELEGRAM_BOT_TOKEN;
    writeFileSync(
      configPath,
      `${JSON.stringify({
        profiles: { studio: { telegramBotToken: "file-token", telegramDefaultTier: "creative" } },
      })}\n`,
      "utf8",
    );
    const bot = {
      getMe: vi.fn(async () => ({ id: 42, is_bot: true })),
    } as unknown as TelegramBotClient;

    try {
      await runTelegram(
        ["setup", "--config", configPath, "--profile", "studio", "--chat-id", "444"],
        {
          createBotClient: (cfg) => {
            expect(cfg.telegramBotToken).toBe("file-token");
            return bot;
          },
          writeStdout: () => {},
        },
      );

      const saved = JSON.parse(readFileSync(configPath, "utf8"));
      expect(saved.profiles.studio).toMatchObject({
        telegramBotToken: "file-token",
        telegramAllowedChats: ["444"],
        telegramDefaultTier: "creative",
      });
    } finally {
      if (originalToken === undefined) delete process.env.TDMCP_TELEGRAM_BOT_TOKEN;
      else process.env.TDMCP_TELEGRAM_BOT_TOKEN = originalToken;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves setup config from TDMCP_CONFIG_FILE and environment token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tdmcp-telegram-env-"));
    const configPath = join(dir, "config.json");
    const originalConfigFile = process.env.TDMCP_CONFIG_FILE;
    const originalToken = process.env.TDMCP_TELEGRAM_BOT_TOKEN;
    process.env.TDMCP_CONFIG_FILE = configPath;
    process.env.TDMCP_TELEGRAM_BOT_TOKEN = "env-token";
    const bot = {
      getMe: vi.fn(async () => ({ id: 7, is_bot: true })),
    } as unknown as TelegramBotClient;
    let stdout = "";

    try {
      await runTelegram(["setup", "--chat-id", "555"], {
        createBotClient: (cfg) => {
          expect(cfg.telegramBotToken).toBe("env-token");
          return bot;
        },
        writeStdout: (chunk) => {
          stdout += chunk;
        },
      });

      const saved = JSON.parse(readFileSync(configPath, "utf8"));
      expect(saved.telegramBotToken).toBe("env-token");
      expect(saved.telegramAllowedChats).toEqual(["555"]);
      expect(stdout).toContain("bot id 7");
    } finally {
      if (originalConfigFile === undefined) delete process.env.TDMCP_CONFIG_FILE;
      else process.env.TDMCP_CONFIG_FILE = originalConfigFile;
      if (originalToken === undefined) delete process.env.TDMCP_TELEGRAM_BOT_TOKEN;
      else process.env.TDMCP_TELEGRAM_BOT_TOKEN = originalToken;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports setup failures for empty tokens, invalid configs, no chat, and declines", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tdmcp-telegram-failures-"));
    try {
      let stderr = "";
      await runTelegram(
        ["setup", "--config", join(dir, "empty.json"), "--chat-id", "1", "--token-stdin"],
        {
          readStdin: async () => "   \n",
          writeStderr: (chunk) => {
            stderr += chunk;
          },
        },
      );
      expect(stderr).toContain("Telegram bot token is empty");

      stderr = "";
      const malformedPath = join(dir, "malformed.json");
      writeFileSync(malformedPath, "{not json", "utf8");
      await runTelegram(["setup", "--config", malformedPath, "--chat-id", "1"], {
        readSecret: async () => "unused",
        writeStderr: (chunk) => {
          stderr += chunk;
        },
      });
      expect(stderr).toContain("cannot read config file");

      stderr = "";
      const arrayPath = join(dir, "array.json");
      writeFileSync(arrayPath, "[]\n", "utf8");
      await runTelegram(["setup", "--config", arrayPath, "--chat-id", "1"], {
        readSecret: async () => "unused",
        writeStderr: (chunk) => {
          stderr += chunk;
        },
      });
      expect(stderr).toContain("must contain a JSON object");

      stderr = "";
      const botWithoutUpdates = {
        getMe: vi.fn(async () => ({ id: 42, is_bot: true, username: "tdmcp_bot" })),
        deleteWebhook: vi.fn(async () => ({ ok: true })),
        getUpdates: vi.fn(async () => []),
      } as unknown as TelegramBotClient;
      await runTelegram(["setup", "--config", join(dir, "no-chat.json"), "--token-stdin"], {
        createBotClient: () => botWithoutUpdates,
        readStdin: async () => "secret-token\n",
        readLine: async () => "",
        writeStdout: () => {},
        writeStderr: (chunk) => {
          stderr += chunk;
        },
      });
      expect(stderr).toContain("no Telegram message received");

      stderr = "";
      const botWithUpdate = {
        getMe: vi.fn(async () => ({ id: 42, is_bot: true, username: "tdmcp_bot" })),
        deleteWebhook: vi.fn(async () => ({ ok: true })),
        getUpdates: vi.fn(async () => [
          { update_id: 7, message: { chat: { id: 222 }, text: "hello" } },
        ]),
      } as unknown as TelegramBotClient;
      const answers = ["", "no"];
      await runTelegram(["setup", "--config", join(dir, "declined.json"), "--token-stdin"], {
        createBotClient: () => botWithUpdate,
        readStdin: async () => "secret-token\n",
        readLine: async () => answers.shift() ?? "",
        writeStdout: () => {},
        writeStderr: (chunk) => {
          stderr += chunk;
        },
      });
      expect(stderr).toContain("setup cancelled");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports non-tty setup when no token is configured and stdin is not piped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tdmcp-telegram-no-tty-"));
    const configPath = join(dir, "config.json");
    const originalToken = process.env.TDMCP_TELEGRAM_BOT_TOKEN;
    delete process.env.TDMCP_TELEGRAM_BOT_TOKEN;
    let stderr = "";

    try {
      await runTelegram(["setup", "--config", configPath, "--chat-id", "111"], {
        writeStderr: (chunk) => {
          stderr += chunk;
        },
      });

      expect(stderr).toContain("interactive token input requires a TTY");
      expect(process.exitCode).toBe(2);
    } finally {
      if (originalToken === undefined) delete process.env.TDMCP_TELEGRAM_BOT_TOKEN;
      else process.env.TDMCP_TELEGRAM_BOT_TOKEN = originalToken;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to start without a bot token or any allowlist", async () => {
    let stderr = "";
    let overrides: unknown;
    await runTelegram(["--once", "--creative"], {
      loadConfig: (_env, opts) => {
        overrides = opts?.overrides;
        return loadConfig({});
      },
      writeStderr: (chunk) => {
        stderr += chunk;
      },
      writeStdout: () => {},
    });

    expect(stderr).toContain("TDMCP_TELEGRAM_BOT_TOKEN");
    expect(overrides).toMatchObject({ telegramDefaultTier: "creative" });
    expect(process.exitCode).toBe(2);
  });

  it("refuses to start with a token but no allowlist", async () => {
    let stderr = "";
    await runTelegram(["--once"], {
      loadConfig: () => loadConfig({ TDMCP_TELEGRAM_BOT_TOKEN: "secret-token" }),
      writeStderr: (chunk) => {
        stderr += chunk;
      },
      writeStdout: () => {},
    });

    expect(stderr).toContain("TDMCP_TELEGRAM_ALLOWED_CHATS");
    expect(process.exitCode).toBe(2);
  });

  it("drops pending updates and handles one polling batch in once mode", async () => {
    const updates = [{ update_id: 10, message: { chat: { id: 111 }, text: "inspect" } }];
    const bot = {
      deleteWebhook: vi.fn(async () => ({ ok: true })),
      getUpdates: vi.fn(async () => updates),
    } as unknown as TelegramBotClient;
    const service = { handleUpdate: vi.fn(async () => {}) };
    let stdout = "";

    await runTelegram(["--once", "--drop-pending-updates", "--poll-timeout", "9"], {
      loadConfig: (_env, opts) =>
        loadConfig(
          {
            TDMCP_TELEGRAM_BOT_TOKEN: "secret-token",
            TDMCP_TELEGRAM_ALLOWED_CHATS: "111",
          },
          opts,
        ),
      buildToolContext: () => makeCtx(),
      createClient: () => ({}) as LlmClient,
      createBotClient: () => bot,
      createService: () => service as unknown as TelegramCopilotService,
      writeStdout: (chunk) => {
        stdout += chunk;
      },
    });

    expect(bot.deleteWebhook).toHaveBeenCalledWith(true);
    expect(bot.getUpdates).toHaveBeenCalledWith({ offset: undefined, timeout: 9 });
    expect(service.handleUpdate).toHaveBeenCalledWith(updates[0]);
    expect(stdout).toContain("default-tier=safe");
  });

  it("passes profile, config, and tier overrides while using the default service", async () => {
    const bot = {
      getUpdates: vi.fn(async () => []),
      sendMessage: vi.fn(async () => {}),
    } as unknown as TelegramBotClient;
    let stdout = "";
    let loadOptions: Parameters<typeof loadConfig>[1] | undefined;

    await runTelegram(
      ["--once", "--tier", "standard", "--profile", "club", "--config", "/tmp/tdmcp.json"],
      {
        loadConfig: (_env, opts) => {
          loadOptions = opts;
          return loadConfig(
            {
              TDMCP_TELEGRAM_BOT_TOKEN: "secret-token",
              TDMCP_TELEGRAM_ALLOWED_CHATS: "111",
            },
            { overrides: opts?.overrides },
          );
        },
        buildToolContext: () => makeCtx(),
        createClient: () => ({}) as LlmClient,
        createBotClient: () => bot,
        runAgentTurn: answeringTurn("ok", { prompts: [], tools: [] }),
        writeStdout: (chunk) => {
          stdout += chunk;
        },
      },
    );

    expect(loadOptions).toMatchObject({
      useFiles: true,
      profile: "club",
      configPath: "/tmp/tdmcp.json",
      overrides: { telegramDefaultTier: "standard" },
    });
    expect(bot.getUpdates).toHaveBeenCalledWith({ offset: undefined, timeout: 30 });
    expect(stdout).toContain("default-tier=standard");
  });

  it("keeps polling until a process signal stops the long-running loop", async () => {
    const bot = {
      getUpdates: vi.fn(async () => {
        process.emit("SIGINT", "SIGINT");
        return [];
      }),
    } as unknown as TelegramBotClient;

    await runTelegram([], {
      loadConfig: () =>
        loadConfig({
          TDMCP_TELEGRAM_BOT_TOKEN: "secret-token",
          TDMCP_TELEGRAM_ALLOWED_CHATS: "111",
        }),
      buildToolContext: () => makeCtx(),
      createClient: () => ({}) as LlmClient,
      createBotClient: () => bot,
      createService: () =>
        ({ handleUpdate: vi.fn(async () => {}) }) as unknown as TelegramCopilotService,
      writeStdout: () => {},
    });

    expect(bot.getUpdates).toHaveBeenCalledTimes(1);
  });
});
