import { parseArgs } from "node:util";
import { runAgentTurn } from "../llm/agent.js";
import { LlmClient } from "../llm/client.js";
import type { ToolTier } from "../llm/tools.js";
import { buildToolContext } from "../server/context.js";
import { TelegramBotClient } from "../telegram/client.js";
import { TelegramCopilotService } from "../telegram/copilot.js";
import { type LoadConfigOptions, type LoadedTdmcpConfig, loadConfig } from "../utils/config.js";
import { createLogger } from "../utils/logger.js";

export interface TelegramCliOptions {
  help: boolean;
  once: boolean;
  readOnly: boolean;
  creative: boolean;
  dropPendingUpdates: boolean;
  pollTimeoutSec?: number;
  profile?: string;
  configPath?: string;
  tier?: ToolTier;
}

interface TelegramRuntimeDeps {
  loadConfig?: (env?: NodeJS.ProcessEnv, opts?: LoadConfigOptions) => LoadedTdmcpConfig;
  createLogger?: typeof createLogger;
  buildToolContext?: typeof buildToolContext;
  createClient?: (config: LoadedTdmcpConfig) => LlmClient;
  createBotClient?: (config: LoadedTdmcpConfig) => TelegramBotClient;
  createService?: (
    config: LoadedTdmcpConfig,
    bot: TelegramBotClient,
    client: LlmClient,
  ) => TelegramCopilotService;
  runAgentTurn?: typeof runAgentTurn;
  writeStdout?: (chunk: string) => void;
  writeStderr?: (chunk: string) => void;
}

const HELP = `tdmcp telegram — local Telegram entry point for the Ollama copilot

Usage: tdmcp telegram [flags]

Receives allowlisted Telegram messages through Bot API long polling, then routes
them to the existing local LLM copilot and TouchDesigner bridge.

Required environment:
  TDMCP_TELEGRAM_BOT_TOKEN          Bot token from BotFather.
  TDMCP_TELEGRAM_ALLOWED_CHATS      Comma-separated chat ids allowed to use it.
  TDMCP_TELEGRAM_ALLOWED_USERS      Optional comma-separated user ids.

Flags:
  --once                   Poll once and exit (useful for tests/supervisors).
  --read-only              Force the Telegram default tier to safe.
  --creative               Start chats in creative tier (still requires /approve).
  --tier <safe|standard|creative>
                           Explicit Telegram default tier.
  --poll-timeout <sec>     getUpdates long-poll timeout, 1-60 seconds.
  --drop-pending-updates   Clear Telegram's pending update queue before polling.
  --profile <name>         Use a named profile from tdmcp.json / .tdmcprc.
  --config <path>          Use a specific config file instead of the search order.
  -h, --help               Show this help.

Security:
  Telegram defaults to safe mode. standard/creative prompts are staged and only
  run after /approve. Non-allowlisted messages never reach the LLM.`;

function parseTier(value: string | undefined): ToolTier | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "safe" || normalized === "standard" || normalized === "creative") {
    return normalized;
  }
  throw new Error(`--tier must be safe, standard, or creative (got "${value}")`);
}

export function parseTelegramArgs(argv: string[] = []): TelegramCliOptions {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      help: { type: "boolean", short: "h", default: false },
      once: { type: "boolean", default: false },
      "read-only": { type: "boolean", default: false },
      creative: { type: "boolean", default: false },
      tier: { type: "string" },
      "poll-timeout": { type: "string" },
      "drop-pending-updates": { type: "boolean", default: false },
      profile: { type: "string" },
      config: { type: "string" },
    },
  });

  let pollTimeoutSec: number | undefined;
  if (typeof values["poll-timeout"] === "string") {
    const parsed = Number.parseInt(values["poll-timeout"], 10);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 60) {
      throw new Error(`--poll-timeout must be an integer from 1 to 60 seconds`);
    }
    pollTimeoutSec = parsed;
  }

  return {
    help: values.help === true,
    once: values.once === true,
    readOnly: values["read-only"] === true,
    creative: values.creative === true,
    dropPendingUpdates: values["drop-pending-updates"] === true,
    ...(pollTimeoutSec !== undefined ? { pollTimeoutSec } : {}),
    ...(typeof values.profile === "string" ? { profile: values.profile } : {}),
    ...(typeof values.config === "string" ? { configPath: values.config } : {}),
    ...(parseTier(typeof values.tier === "string" ? values.tier : undefined)
      ? { tier: parseTier(values.tier as string) }
      : {}),
  };
}

function telegramOverrides(
  opts: TelegramCliOptions,
): Partial<Record<keyof LoadedTdmcpConfig, unknown>> {
  const overrides: Partial<Record<keyof LoadedTdmcpConfig, unknown>> = {};
  if (opts.pollTimeoutSec !== undefined) overrides.telegramPollTimeoutSec = opts.pollTimeoutSec;
  if (opts.readOnly) overrides.telegramDefaultTier = "safe";
  else if (opts.tier) overrides.telegramDefaultTier = opts.tier;
  else if (opts.creative) overrides.telegramDefaultTier = "creative";
  return overrides;
}

function hasAllowlist(config: LoadedTdmcpConfig): boolean {
  return config.telegramAllowedChats.length > 0 || config.telegramAllowedUsers.length > 0;
}

export async function runTelegram(
  argv: string[] = [],
  deps: TelegramRuntimeDeps = {},
): Promise<void> {
  const writeStdout = deps.writeStdout ?? ((chunk: string) => process.stdout.write(chunk));
  const writeStderr = deps.writeStderr ?? ((chunk: string) => process.stderr.write(chunk));

  let opts: TelegramCliOptions;
  try {
    opts = parseTelegramArgs(argv);
  } catch (err) {
    writeStderr(`tdmcp telegram: ${(err as Error).message}\n\n${HELP}\n`);
    process.exitCode = 2;
    return;
  }

  if (opts.help) {
    writeStdout(`${HELP}\n`);
    return;
  }

  const load = deps.loadConfig ?? loadConfig;
  const config = load(process.env, {
    useFiles: true,
    ...(opts.profile !== undefined ? { profile: opts.profile } : {}),
    ...(opts.configPath !== undefined ? { configPath: opts.configPath } : {}),
    overrides: telegramOverrides(opts),
  });

  if (!config.telegramBotToken) {
    writeStderr("tdmcp telegram: TDMCP_TELEGRAM_BOT_TOKEN is required.\n");
    process.exitCode = 2;
    return;
  }
  if (!hasAllowlist(config)) {
    writeStderr(
      "tdmcp telegram: set TDMCP_TELEGRAM_ALLOWED_CHATS or TDMCP_TELEGRAM_ALLOWED_USERS before starting.\n",
    );
    process.exitCode = 2;
    return;
  }

  const makeLogger = deps.createLogger ?? createLogger;
  const makeContext = deps.buildToolContext ?? buildToolContext;
  const makeClient = deps.createClient ?? ((cfg: LoadedTdmcpConfig) => new LlmClient(cfg));
  const makeBot =
    deps.createBotClient ??
    ((cfg: LoadedTdmcpConfig) => new TelegramBotClient({ token: cfg.telegramBotToken ?? "" }));
  const turn = deps.runAgentTurn ?? runAgentTurn;
  const logger = makeLogger(config.logLevel === "silent" ? "silent" : "warn");
  const ctx = makeContext(config, { logger });
  const llm = makeClient(config);
  const bot = makeBot(config);
  const service =
    deps.createService?.(config, bot, llm) ??
    new TelegramCopilotService({
      ctx,
      client: llm,
      sender: bot,
      runAgentTurn: turn,
      allowedChatIds: new Set(config.telegramAllowedChats),
      allowedUserIds: new Set(config.telegramAllowedUsers),
      defaultTier: config.telegramDefaultTier,
      confirmTimeoutMs: config.telegramConfirmTimeoutMs,
    });

  if (opts.dropPendingUpdates) await bot.deleteWebhook(true);

  let offset: number | undefined;
  const pollOnce = async () => {
    const updates = await bot.getUpdates({
      offset,
      timeout: config.telegramPollTimeoutSec,
    });
    for (const update of updates) {
      offset = update.update_id + 1;
      await service.handleUpdate(update);
    }
  };

  writeStdout(
    `tdmcp telegram · model=${config.llmModel} · default-tier=${config.telegramDefaultTier}\n`,
  );

  if (opts.once) {
    await pollOnce();
    return;
  }

  let running = true;
  const stop = () => {
    running = false;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    while (running) {
      await pollOnce();
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
