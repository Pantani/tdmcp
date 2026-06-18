import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { runAgentTurn } from "../llm/agent.js";
import { LlmClient } from "../llm/client.js";
import { startChatServer } from "../llm/server.js";
import { resolveTools } from "../llm/tools.js";
import { buildToolContext } from "../server/context.js";
import type { ToolContext } from "../tools/types.js";
import {
  DEFAULT_LLM_TEMPERATURE,
  type LoadConfigOptions,
  type LoadedTdmcpConfig,
  loadConfig,
} from "../utils/config.js";
import { createLogger } from "../utils/logger.js";

function openBrowser(url: string): void {
  const platform = process.platform;
  const [cmd, args] =
    platform === "darwin"
      ? ["open", [url]]
      : platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    spawn(cmd as string, args as string[], { stdio: "ignore", detached: true }).unref();
  } catch {
    // Opening the browser is best-effort; the URL is printed regardless.
  }
}

/** Is the `ollama` binary on PATH? (So we only offer to start what exists.) */
function ollamaOnPath(): boolean {
  const probe = process.platform === "win32" ? "where" : "which";
  return spawnSync(probe, ["ollama"], { stdio: "ignore" }).status === 0;
}

/** True when the endpoint is Ollama's local default (the only case we auto-start). */
export function isLocalOllama(baseUrl: string): boolean {
  return /(?:127\.0\.0\.1|localhost|0\.0\.0\.0):11434\b/.test(baseUrl);
}

/**
 * Make sure Ollama is reachable, starting it if needed. We only auto-start when
 * (a) auto-start is on, (b) the endpoint is the local Ollama default, and (c) the
 * `ollama` binary exists — so a remote/cloud endpoint or a missing install is never
 * touched. The daemon is spawned detached and left running (warm for next time, and
 * so quitting the chat doesn't take the model offline). Returns whether it is up.
 */
async function ensureOllamaUp(
  client: LlmClient,
  baseUrl: string,
  autoStart: boolean,
  log: (msg: string) => void,
): Promise<boolean> {
  if ((await client.health()).ok) return true; // already reachable
  if (!autoStart) return false;
  if (!isLocalOllama(baseUrl)) return false; // remote/custom endpoint — not ours to manage
  if (!ollamaOnPath()) {
    log("  ⚠ Ollama isn't installed. Get it at https://ollama.com (or pass --no-ollama).");
    return false;
  }
  log("  ⏳ Ollama isn't running — starting it…");
  // Detached + unref: it keeps serving after this command exits, so the model stays
  // warm and quitting the chat never knocks it offline.
  const child = spawn("ollama", ["serve"], { stdio: "ignore", detached: true });
  child.on("error", () => {
    /* reported by the health poll below */
  });
  child.unref();
  for (let i = 0; i < 30; i++) {
    await delay(500);
    if ((await client.health()).ok) {
      log("  ✓ Ollama is up (left running in the background).");
      return true;
    }
  }
  log("  ⚠ Ollama didn't respond in time — check it with `ollama serve` manually.");
  return false;
}

export const CREATIVE_CHAT_TEMPERATURE = 0.85;

export interface ChatCliOptions {
  help: boolean;
  openBrowser: boolean;
  autoStartOllama: boolean;
  readOnly: boolean;
  creative: boolean;
  prompt?: string;
  profile?: string;
  configPath?: string;
}

interface ChatRuntimeDeps {
  loadConfig?: (env?: NodeJS.ProcessEnv, opts?: LoadConfigOptions) => LoadedTdmcpConfig;
  createLogger?: typeof createLogger;
  buildToolContext?: typeof buildToolContext;
  createClient?: (config: LoadedTdmcpConfig) => LlmClient;
  startChatServer?: typeof startChatServer;
  openBrowser?: (url: string) => void;
  ensureOllamaUp?: typeof ensureOllamaUp;
  writeStdout?: (chunk: string) => void;
  writeStderr?: (chunk: string) => void;
}

const HELP = `tdmcp chat — local LLM copilot in your browser (alias: tdmcp llm-run)

Usage: tdmcp chat [flags]

Flags:
  --read-only       Expose only inspection/readiness tools to the local copilot.
  --creative        Use the creative tool tier and a warmer sampling preset.
  --prompt <text>   Run one headless prompt and print the answer; don't open the browser.
  --no-ollama       Don't auto-start Ollama; assume the endpoint is already running.
  --no-open         Don't open the browser automatically.
  --profile <name>  Use a named profile from tdmcp.json / .tdmcprc.
  --config <path>   Use a specific config file instead of the search order.
  -h, --help        Show this help.

By default, if the configured endpoint is local Ollama and it isn't running,
tdmcp chat starts it for you and leaves it running. Configure the model and
endpoint with TDMCP_LLM_MODEL / TDMCP_LLM_BASE_URL, or live from the UI.
If --read-only and --creative are both provided, read-only wins for tool access.`;

export function parseChatArgs(argv: string[] = []): ChatCliOptions {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      help: { type: "boolean", short: "h", default: false },
      "no-open": { type: "boolean", default: false },
      "no-ollama": { type: "boolean", default: false },
      "read-only": { type: "boolean", default: false },
      creative: { type: "boolean", default: false },
      prompt: { type: "string" },
      profile: { type: "string" },
      config: { type: "string" },
    },
  });

  return {
    help: values.help === true,
    openBrowser: values["no-open"] !== true,
    autoStartOllama: values["no-ollama"] !== true,
    readOnly: values["read-only"] === true,
    creative: values.creative === true,
    ...(typeof values.prompt === "string" ? { prompt: values.prompt } : {}),
    ...(typeof values.profile === "string" ? { profile: values.profile } : {}),
    ...(typeof values.config === "string" ? { configPath: values.config } : {}),
  };
}

export function applyChatFlagOverrides(
  config: LoadedTdmcpConfig,
  opts: Pick<ChatCliOptions, "readOnly" | "creative">,
): LoadedTdmcpConfig {
  const next = { ...config };
  if (opts.readOnly) {
    next.llmTier = "safe";
    return next;
  }
  if (opts.creative) {
    next.llmTier = "creative";
    next.llmTemperature = Math.max(
      next.llmTemperature ?? DEFAULT_LLM_TEMPERATURE,
      CREATIVE_CHAT_TEMPERATURE,
    );
  }
  return next;
}

export async function runHeadlessPrompt(
  ctx: ToolContext,
  client: LlmClient,
  prompt: string,
  config: Pick<LoadedTdmcpConfig, "llmTier" | "llmMaxSteps">,
  writeStdout: (chunk: string) => void = (chunk) => process.stdout.write(chunk),
): Promise<void> {
  let answer: string | undefined;
  let error: string | undefined;
  const messages = await runAgentTurn(
    ctx,
    client,
    [{ role: "user", content: prompt }],
    (event) => {
      if (event.type === "answer") answer = event.content;
      if (event.type === "error") error = event.message;
    },
    {
      tools: resolveTools(config.llmTier, { projectRag: ctx.projectRag !== undefined }),
      maxSteps: config.llmMaxSteps,
    },
  );

  const fallback = [...messages]
    .reverse()
    .find(
      (message) => message.role === "assistant" && typeof message.content === "string",
    )?.content;
  const output = answer ?? fallback ?? (error ? `Error: ${error}` : "");
  if (output) writeStdout(`${output.trimEnd()}\n`);
}

/**
 * `tdmcp chat` — boots the local LLM copilot: ensures Ollama is up (unless
 * --no-ollama), builds the shared tool context, starts the loopback chat UI, and
 * opens the browser. Runs until interrupted (Ctrl-C).
 */
export async function runChat(argv: string[] = [], deps: ChatRuntimeDeps = {}): Promise<void> {
  const writeStdout = deps.writeStdout ?? ((chunk: string) => process.stdout.write(chunk));
  const writeStderr = deps.writeStderr ?? ((chunk: string) => process.stderr.write(chunk));
  let opts: ChatCliOptions;
  try {
    opts = parseChatArgs(argv);
  } catch (err) {
    writeStderr(`tdmcp chat: ${(err as Error).message}\n\n${HELP}\n`);
    process.exitCode = 1;
    return;
  }

  if (opts.help) {
    writeStdout(`${HELP}\n`);
    return;
  }
  const load = deps.loadConfig ?? loadConfig;
  const makeLogger = deps.createLogger ?? createLogger;
  const makeContext = deps.buildToolContext ?? buildToolContext;
  const makeClient = deps.createClient ?? ((config: LoadedTdmcpConfig) => new LlmClient(config));
  const launchServer = deps.startChatServer ?? startChatServer;
  const launchBrowser = deps.openBrowser ?? openBrowser;
  const ensureOllama = deps.ensureOllamaUp ?? ensureOllamaUp;

  const loaded = load(process.env, {
    useFiles: true,
    profile: opts.profile,
    configPath: opts.configPath,
  });
  const config = applyChatFlagOverrides(loaded, opts);
  const logger = makeLogger(config.logLevel === "silent" ? "silent" : "warn");
  const ctx = makeContext(config, { logger });
  const client = makeClient(config);
  const headless = opts.prompt !== undefined;
  const log = (msg: string) => {
    const target = headless ? writeStderr : writeStdout;
    target(`${msg}\n`);
  };

  if (!headless) writeStdout("\n");
  await ensureOllama(client, config.llmBaseUrl, opts.autoStartOllama, log);

  if (headless) {
    await runHeadlessPrompt(ctx, client, opts.prompt ?? "", config, writeStdout);
    return;
  }

  const serverConfig = opts.readOnly ? { ...config, llmLockedTier: "safe" as const } : config;
  const handle = await launchServer(ctx, serverConfig);
  const health = await client.health();

  writeStdout(`\n  tdmcp local copilot → ${handle.url}\n`);
  writeStdout(`  model: ${config.llmModel}  ·  endpoint: ${config.llmBaseUrl}\n`);
  writeStdout(
    `  tier: ${config.llmTier}  ·  temperature: ${
      config.llmTemperature ?? DEFAULT_LLM_TEMPERATURE
    }\n`,
  );
  if (!health.ok) {
    writeStdout(
      `\n  ⚠ LLM endpoint unreachable (${health.detail}).\n` +
        (opts.autoStartOllama
          ? "    Install Ollama from https://ollama.com, then re-run `tdmcp chat`.\n"
          : "    Auto-start is off (--no-ollama) — start it yourself: ollama serve\n"),
    );
  } else if (!health.modelReady) {
    writeStdout(
      `\n  ⚠ ${health.detail}.\n    Pull it with:  ollama pull ${config.llmModel}  (or use the button in the UI)\n`,
    );
  } else {
    writeStdout(`  status: ${health.detail}\n`);
  }
  writeStdout("\n  Press Ctrl-C to stop.\n\n");

  if (opts.openBrowser) launchBrowser(handle.url);

  await new Promise<void>((resolve) => {
    const stop = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      void handle.close().finally(() => resolve());
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
