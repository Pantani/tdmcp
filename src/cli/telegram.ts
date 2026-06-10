import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface, emitKeypressEvents } from "node:readline";
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
  command: "run" | "setup";
  help: boolean;
  once: boolean;
  readOnly: boolean;
  creative: boolean;
  dropPendingUpdates: boolean;
  pollTimeoutSec?: number;
  setupTimeoutSec?: number;
  profile?: string;
  configPath?: string;
  tier?: ToolTier;
  chatId?: string;
  userId?: string;
  tokenStdin: boolean;
  yes: boolean;
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
  readStdin?: () => Promise<string>;
  readLine?: (prompt: string) => Promise<string>;
  readSecret?: (prompt: string) => Promise<string>;
  writeStdout?: (chunk: string) => void;
  writeStderr?: (chunk: string) => void;
}

const HELP = `tdmcp telegram — local Telegram entry point for the Ollama copilot

Usage:
  tdmcp telegram [flags]
  tdmcp telegram setup [flags]

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

Setup:
  tdmcp telegram setup --token-stdin --chat-id <id>

Security:
  Telegram defaults to safe mode. standard/creative prompts are staged and only
  run after /approve. Non-allowlisted messages never reach the LLM.`;

const SETUP_HELP = `tdmcp telegram setup — save Telegram bot credentials locally

Usage: tdmcp telegram setup [flags]

Validates a BotFather token with Telegram getMe, writes it to a tdmcp config
file, and records the Telegram chat/user allowlist used by tdmcp telegram.

Flags:
  --token-stdin            Read the bot token from stdin instead of an echoing argv flag.
  --chat-id <id>           Telegram chat id to allow. If omitted, setup can discover one.
  --user-id <id>           Optional Telegram user id to allow.
  --profile <name>         Write values under profiles.<name>.
  --config <path>          Write this config file.
  --setup-timeout <sec>    getUpdates timeout while discovering a chat, 1-120 seconds.
  --yes                    Accept the discovered chat without a confirmation prompt.
  -h, --help               Show this help.`;

function parseTier(value: string | undefined): ToolTier | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "safe" || normalized === "standard" || normalized === "creative") {
    return normalized;
  }
  throw new Error(`--tier must be safe, standard, or creative (got "${value}")`);
}

export function parseTelegramArgs(argv: string[] = []): TelegramCliOptions {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
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
      "setup-timeout": { type: "string" },
      "chat-id": { type: "string" },
      "user-id": { type: "string" },
      "token-stdin": { type: "boolean", default: false },
      yes: { type: "boolean", default: false },
    },
  });
  const command = positionals[0] === "setup" ? "setup" : "run";
  if (positionals.length > 0 && positionals[0] !== "setup") {
    throw new Error(`unknown telegram subcommand "${positionals[0]}"`);
  }
  if (positionals.length > 1) {
    throw new Error(`tdmcp telegram ${positionals[0]} does not take positional arguments`);
  }

  let pollTimeoutSec: number | undefined;
  if (typeof values["poll-timeout"] === "string") {
    const parsed = Number.parseInt(values["poll-timeout"], 10);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 60) {
      throw new Error(`--poll-timeout must be an integer from 1 to 60 seconds`);
    }
    pollTimeoutSec = parsed;
  }

  let setupTimeoutSec: number | undefined;
  if (typeof values["setup-timeout"] === "string") {
    const parsed = Number.parseInt(values["setup-timeout"], 10);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 120) {
      throw new Error(`--setup-timeout must be an integer from 1 to 120 seconds`);
    }
    setupTimeoutSec = parsed;
  }

  const tier = parseTier(typeof values.tier === "string" ? values.tier : undefined);
  return {
    command,
    help: values.help === true,
    once: values.once === true,
    readOnly: values["read-only"] === true,
    creative: values.creative === true,
    dropPendingUpdates: values["drop-pending-updates"] === true,
    ...(pollTimeoutSec !== undefined ? { pollTimeoutSec } : {}),
    ...(setupTimeoutSec !== undefined ? { setupTimeoutSec } : {}),
    ...(typeof values.profile === "string" ? { profile: values.profile } : {}),
    ...(typeof values.config === "string" ? { configPath: values.config } : {}),
    ...(tier !== undefined ? { tier } : {}),
    ...(typeof values["chat-id"] === "string" ? { chatId: values["chat-id"] } : {}),
    ...(typeof values["user-id"] === "string" ? { userId: values["user-id"] } : {}),
    tokenStdin: values["token-stdin"] === true,
    yes: values.yes === true,
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

function xdgConfigHome(env: NodeJS.ProcessEnv): string {
  return env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
}

function resolveSetupConfigPath(
  opts: Pick<TelegramCliOptions, "configPath">,
  env: NodeJS.ProcessEnv,
  cwd: string,
): string {
  if (opts.configPath) return opts.configPath;
  const explicit = env.TDMCP_CONFIG_FILE?.trim();
  if (explicit) return explicit;
  for (const candidate of [join(cwd, "tdmcp.json"), join(cwd, ".tdmcprc")]) {
    if (existsSync(candidate)) return candidate;
  }
  return join(xdgConfigHome(env), "tdmcp", "config.json");
}

function readJsonObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`cannot read config file ${path}: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`config file ${path} must contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function selectedConfigTarget(
  data: Record<string, unknown>,
  profile: string | undefined,
): Record<string, unknown> {
  if (!profile) return data;
  const profiles =
    data.profiles && typeof data.profiles === "object" && !Array.isArray(data.profiles)
      ? (data.profiles as Record<string, unknown>)
      : {};
  const current =
    profiles[profile] && typeof profiles[profile] === "object" && !Array.isArray(profiles[profile])
      ? (profiles[profile] as Record<string, unknown>)
      : {};
  profiles[profile] = current;
  data.profiles = profiles;
  return current;
}

function saveTelegramSetupConfig(args: {
  path: string;
  profile?: string;
  token: string;
  chatId: string;
  userId?: string;
}): void {
  const data = readJsonObject(args.path);
  const target = selectedConfigTarget(data, args.profile);
  target.telegramBotToken = args.token;
  target.telegramAllowedChats = [args.chatId];
  if (args.userId) target.telegramAllowedUsers = [args.userId];
  if (target.telegramDefaultTier === undefined) target.telegramDefaultTier = "safe";

  mkdirSync(dirname(args.path), { recursive: true, mode: 0o700 });
  writeFileSync(args.path, `${JSON.stringify(data, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    chmodSync(args.path, 0o600);
  } catch {
    // Best effort on platforms/filesystems that do not support chmod.
  }
}

async function defaultReadStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function defaultReadLine(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return await new Promise<string>((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function defaultReadSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) {
    throw new Error("interactive token input requires a TTY; pipe the token with --token-stdin");
  }

  const input = process.stdin;
  const output = process.stdout;
  const wasRaw = input.isRaw;
  emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();
  output.write(prompt);

  return await new Promise<string>((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      input.off("keypress", onKeypress);
      input.setRawMode(wasRaw);
      output.write("\n");
    };
    const onKeypress = (chunk: string, key?: { name?: string; ctrl?: boolean; meta?: boolean }) => {
      if (key?.ctrl && key.name === "c") {
        cleanup();
        reject(new Error("setup cancelled"));
        return;
      }
      if (key?.name === "return" || key?.name === "enter") {
        cleanup();
        resolve(value.trim());
        return;
      }
      if (key?.name === "backspace" || key?.name === "delete") {
        value = value.slice(0, -1);
        return;
      }
      if (chunk && !key?.ctrl && !key?.meta) value += chunk;
    };
    input.on("keypress", onKeypress);
  });
}

function currentSetupToken(
  configPath: string,
  profile: string | undefined,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const envToken = env.TDMCP_TELEGRAM_BOT_TOKEN?.trim();
  if (envToken) return envToken;
  const data = readJsonObject(configPath);
  const target = selectedConfigTarget(data, profile);
  const fileToken = target.telegramBotToken;
  return typeof fileToken === "string" && fileToken.trim() ? fileToken.trim() : undefined;
}

async function readSetupToken(
  opts: TelegramCliOptions,
  configPath: string,
  deps: TelegramRuntimeDeps,
): Promise<string> {
  if (opts.tokenStdin) return (await (deps.readStdin ?? defaultReadStdin)()).trim();
  const existing = currentSetupToken(configPath, opts.profile, process.env);
  if (existing) return existing;
  return await (deps.readSecret ?? defaultReadSecret)("Telegram bot token: ");
}

async function discoverChatId(
  opts: TelegramCliOptions,
  bot: TelegramBotClient,
  readLine: (prompt: string) => Promise<string>,
  writeStdout: (chunk: string) => void,
  botLabel: string,
): Promise<{ chatId: string; userId?: string }> {
  writeStdout(`Send any message to ${botLabel}, then press Enter here.\n`);
  await readLine("Ready? ");
  await bot.deleteWebhook(false);
  const updates = await bot.getUpdates({ timeout: opts.setupTimeoutSec ?? 30 });
  const message = updates.find((update) => update.message?.chat.id !== undefined)?.message;
  if (!message) {
    throw new Error("no Telegram message received; pass --chat-id or run setup again");
  }

  const chatId = String(message.chat.id);
  const userId = message.from?.id !== undefined ? String(message.from.id) : undefined;
  if (!opts.yes) {
    const answer = await readLine(
      `Allow chat ${chatId}${userId ? ` / user ${userId}` : ""}? [y/N] `,
    );
    if (!/^y(es)?$/i.test(answer.trim())) throw new Error("setup cancelled");
  }
  return { chatId, ...(userId ? { userId } : {}) };
}

async function runTelegramSetup(
  opts: TelegramCliOptions,
  deps: TelegramRuntimeDeps,
): Promise<void> {
  const writeStdout = deps.writeStdout ?? ((chunk: string) => process.stdout.write(chunk));
  const configPath = resolveSetupConfigPath(opts, process.env, process.cwd());
  const token = await readSetupToken(opts, configPath, deps);
  if (!token) throw new Error("Telegram bot token is empty");

  const makeBot =
    deps.createBotClient ??
    ((cfg: LoadedTdmcpConfig) => new TelegramBotClient({ token: cfg.telegramBotToken ?? "" }));
  const botConfig = loadConfig({}, { overrides: { telegramBotToken: token } });
  const bot = makeBot(botConfig);
  const me = await bot.getMe();
  const botLabel = me.username ? `@${me.username}` : `bot id ${me.id}`;
  writeStdout(`Telegram token validated for ${botLabel}.\n`);

  const discovered =
    opts.chatId !== undefined
      ? { chatId: opts.chatId, ...(opts.userId ? { userId: opts.userId } : {}) }
      : await discoverChatId(opts, bot, deps.readLine ?? defaultReadLine, writeStdout, botLabel);
  saveTelegramSetupConfig({
    path: configPath,
    profile: opts.profile,
    token,
    chatId: discovered.chatId,
    userId: opts.userId ?? discovered.userId,
  });
  writeStdout(
    `Saved Telegram config to ${configPath}${opts.profile ? ` (profile: ${opts.profile})` : ""}.\n`,
  );
  writeStdout(`Allowed chat: ${discovered.chatId}\n`);
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
    writeStdout(`${opts.command === "setup" ? SETUP_HELP : HELP}\n`);
    return;
  }

  if (opts.command === "setup") {
    try {
      await runTelegramSetup(opts, deps);
    } catch (err) {
      writeStderr(`tdmcp telegram setup: ${(err as Error).message}\n`);
      process.exitCode = 2;
    }
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
