import { parseArgs } from "node:util";
import { runAgentTurn } from "../llm/agent.js";
import type { ChatMessage } from "../llm/client.js";
import { LlmClient } from "../llm/client.js";
import { buildCreativeContextMessage, clampK } from "../llm/creativeContext.js";
import { buildFusedContextMessage, fusedRagSearch } from "../llm/crossRagFusion.js";
import { resolveTools } from "../llm/tools.js";
import { buildToolContext } from "../server/context.js";
import {
  DEFAULT_LLM_TEMPERATURE,
  type LoadConfigOptions,
  type LoadedTdmcpConfig,
  loadConfig,
} from "../utils/config.js";
import { createLogger } from "../utils/logger.js";
import { applyChatFlagOverrides, CREATIVE_CHAT_TEMPERATURE, isLocalOllama } from "./chat.js";

export interface AskCliOptions {
  help: boolean;
  json: boolean;
  toolsOff: boolean;
  autoStartOllama: boolean;
  readOnly: boolean;
  creative: boolean;
  withCreative: boolean;
  timeoutMs: number;
  prompt?: string;
  model?: string;
  profile?: string;
  configPath?: string;
}

interface AskRuntimeDeps {
  loadConfig?: (env?: NodeJS.ProcessEnv, opts?: LoadConfigOptions) => LoadedTdmcpConfig;
  createLogger?: typeof createLogger;
  buildToolContext?: typeof buildToolContext;
  createClient?: (config: LoadedTdmcpConfig) => LlmClient;
  ensureOllamaUp?: (
    client: LlmClient,
    baseUrl: string,
    autoStart: boolean,
    log: (msg: string) => void,
  ) => Promise<boolean>;
  runAgentTurn?: typeof runAgentTurn;
  writeStdout?: (chunk: string) => void;
  writeStderr?: (chunk: string) => void;
  readStdin?: () => Promise<string>;
  isStdinTTY?: () => boolean;
  now?: () => number;
}

const HELP = `tdmcp ask — one-shot copilot prompt (pipeable)

Usage: tdmcp ask [flags] [prompt...]

Reads piped stdin (if any) and appends it to the prompt with a blank-line separator.

Flags:
  --json            Emit a single JSON line: {answer,error?,durationMs,model,tier,toolCalls}.
  --tools=on|off    Pass --tools=off to bypass tool calls (pure model answer).
  --model <name>    Override llmModel for this turn.
  --profile <name>  Use a named profile from tdmcp.json / .tdmcprc.
  --config <path>   Use a specific config file instead of the search order.
  --read-only       Force the safe tier (inspection only).
  --creative        Use the creative tier and a warmer sampling preset.
  --with-creative   Inject top creative RAG cards as passive system context
                    (requires TDMCP_RAG_ENABLED=1). Also enabled via
                    TDMCP_RAG_INJECT_ASK=1. Card count: TDMCP_RAG_INJECT_K
                    (default 3, max 5).
  --no-ollama       Don't auto-start local Ollama.
  --timeout <ms>    Wall-clock cap on the turn (default 120000). Exits 124 on hit.
  -h, --help        Show this help.

Stdout carries only the answer (or JSON line); progress/warnings go to stderr.

Exit codes: 0 ok, 1 model/tool error, 2 usage error, 3 endpoint unreachable, 124 timeout.`;

export function parseAskArgs(argv: string[] = []): AskCliOptions {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h", default: false },
      json: { type: "boolean", default: false },
      tools: { type: "string" },
      model: { type: "string" },
      profile: { type: "string" },
      config: { type: "string" },
      "read-only": { type: "boolean", default: false },
      creative: { type: "boolean", default: false },
      "with-creative": { type: "boolean", default: false },
      "no-ollama": { type: "boolean", default: false },
      timeout: { type: "string" },
    },
  });

  const toolsRaw = typeof values.tools === "string" ? values.tools.toLowerCase() : "on";
  if (toolsRaw !== "on" && toolsRaw !== "off") {
    throw new Error(`--tools must be "on" or "off" (got "${values.tools}")`);
  }
  let timeoutMs = 120_000;
  if (typeof values.timeout === "string") {
    const parsed = Number.parseInt(values.timeout, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`--timeout must be a positive integer (ms), got "${values.timeout}"`);
    }
    timeoutMs = parsed;
  }
  const prompt = positionals.join(" ").trim();

  return {
    help: values.help === true,
    json: values.json === true,
    toolsOff: toolsRaw === "off",
    autoStartOllama: values["no-ollama"] !== true,
    readOnly: values["read-only"] === true,
    creative: values.creative === true,
    withCreative: values["with-creative"] === true,
    timeoutMs,
    ...(prompt.length > 0 ? { prompt } : {}),
    ...(typeof values.model === "string" ? { model: values.model } : {}),
    ...(typeof values.profile === "string" ? { profile: values.profile } : {}),
    ...(typeof values.config === "string" ? { configPath: values.config } : {}),
  };
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * `tdmcp ask "<prompt>"` — non-interactive copilot turn. Pipes stdin into the
 * prompt, runs one agent turn, prints the answer (or a single JSON line), exits.
 */
export async function runAsk(argv: string[] = [], deps: AskRuntimeDeps = {}): Promise<void> {
  const writeStdout = deps.writeStdout ?? ((chunk: string) => process.stdout.write(chunk));
  const writeStderr = deps.writeStderr ?? ((chunk: string) => process.stderr.write(chunk));
  const stderrLine = (msg: string) => writeStderr(`${msg}\n`);

  let opts: AskCliOptions;
  try {
    opts = parseAskArgs(argv);
  } catch (err) {
    writeStderr(`tdmcp ask: ${(err as Error).message}\n\n${HELP}\n`);
    process.exitCode = 2;
    return;
  }

  if (opts.help) {
    writeStdout(`${HELP}\n`);
    return;
  }

  const isTTY = deps.isStdinTTY ? deps.isStdinTTY() : Boolean(process.stdin.isTTY);
  let stdinText = "";
  if (!isTTY) {
    const read = deps.readStdin ?? readAllStdin;
    stdinText = (await read()).trim();
  }

  const promptParts: string[] = [];
  if (opts.prompt) promptParts.push(opts.prompt);
  if (stdinText.length > 0) promptParts.push(stdinText);
  const prompt = promptParts.join("\n\n");

  if (!prompt) {
    writeStderr(`tdmcp ask: no prompt provided.\n\n${HELP}\n`);
    process.exitCode = 2;
    return;
  }

  const load = deps.loadConfig ?? loadConfig;
  const makeLogger = deps.createLogger ?? createLogger;
  const makeContext = deps.buildToolContext ?? buildToolContext;
  const makeClient = deps.createClient ?? ((config: LoadedTdmcpConfig) => new LlmClient(config));
  const ensureOllama = deps.ensureOllamaUp;
  const turn = deps.runAgentTurn ?? runAgentTurn;
  const now = deps.now ?? (() => Date.now());

  const loaded = load(process.env, {
    useFiles: true,
    ...(opts.profile !== undefined ? { profile: opts.profile } : {}),
    ...(opts.configPath !== undefined ? { configPath: opts.configPath } : {}),
  });
  let config = applyChatFlagOverrides(loaded, {
    readOnly: opts.readOnly,
    creative: opts.creative,
  });
  if (opts.model) config = { ...config, llmModel: opts.model };
  if (
    opts.creative &&
    (config.llmTemperature ?? DEFAULT_LLM_TEMPERATURE) < CREATIVE_CHAT_TEMPERATURE
  ) {
    config = { ...config, llmTemperature: CREATIVE_CHAT_TEMPERATURE };
  }

  const logger = makeLogger(config.logLevel === "silent" ? "silent" : "warn");
  const ctx = makeContext(config, { logger });
  const client = makeClient(config);

  const start = now();
  const tier = opts.toolsOff ? "chat" : config.llmTier;

  stderrLine(
    `tdmcp ask · model=${config.llmModel} · tier=${tier} · tools=${opts.toolsOff ? "off" : "on"}`,
  );

  // Ollama health check / autostart (mirrors runChat's headless branch).
  if (ensureOllama) {
    const up = await ensureOllama(client, config.llmBaseUrl, opts.autoStartOllama, stderrLine);
    if (!up) {
      const detail = `LLM endpoint not reachable at ${config.llmBaseUrl}`;
      if (opts.json) {
        writeStdout(
          `${JSON.stringify({
            answer: "",
            error: detail,
            durationMs: now() - start,
            model: config.llmModel,
            tier,
            toolCalls: [],
          })}\n`,
        );
      } else {
        stderrLine(`tdmcp ask: ${detail}`);
      }
      process.exitCode = 3;
      return;
    }
  } else if (!isLocalOllama(config.llmBaseUrl)) {
    // No autostart in the harness — just continue; the turn itself will fail loudly.
  }

  const tools = opts.toolsOff
    ? []
    : resolveTools(config.llmTier, { projectRag: ctx.projectRag !== undefined });
  const toolCalls: { name: string; ok: boolean }[] = [];
  let answer: string | undefined;
  let errorMessage: string | undefined;

  // Creative RAG injection — passive context prepended as a user message.
  // Flag wins over the env-derived config flag; RAG disabled → warn + skip
  // (not an error). All knobs come from the parsed config (single source of
  // truth) so file-based config and profiles work the same as env vars.
  const inject = opts.withCreative || config.ragInjectAsk === true;
  let creativeMsg: ChatMessage | undefined;
  if (inject) {
    if (!ctx.creativeRag) {
      stderrLine("tdmcp ask: creative context requested but TDMCP_RAG_ENABLED is off — skipping");
    } else {
      // Cross-RAG fusion (opt-in): when ragEnabled && projectRagEnabled &&
      // ragFusion and both corpora yield results, fuse them via RRF. Otherwise
      // fall back to the existing single-corpus creative context — behaviour is
      // byte-for-byte identical to before when the flag is off.
      const fusionEnabled = config.ragEnabled && config.projectRagEnabled && config.ragFusion;
      const fused = fusionEnabled
        ? await fusedRagSearch(prompt, {
            creative: ctx.creativeRag,
            project: ctx.projectRag,
            fusionEnabled,
            k: config.ragFusionK,
            perCorpusK: clampK(config.ragInjectK),
            logger,
          })
        : undefined;
      creativeMsg = fused
        ? buildFusedContextMessage(fused)
        : await buildCreativeContextMessage(ctx.creativeRag, prompt, {
            k: clampK(config.ragInjectK),
            timeoutMs: config.ragInjectTimeoutMs,
            logger,
          });
    }
  }
  const messages: ChatMessage[] = creativeMsg
    ? [creativeMsg, { role: "user", content: prompt }]
    : [{ role: "user", content: prompt }];

  // AbortController lets the timeout branch actually cancel the in-flight turn
  // (streaming fetch + tool loop) so the Node process can exit at 124 instead
  // of being held open by the still-running underlying request.
  const controller = new AbortController();

  // Wrap so a thrown rejection (instead of an emitted "error" event) becomes an
  // errorMessage assignment — otherwise Promise.race would reject, skip the
  // clearTimeout/abort cleanup, and crash the CLI with an unhandled exception.
  const turnPromise = (async () => {
    try {
      const turnResult = await turn(
        ctx,
        client,
        messages,
        (event) => {
          if (event.type === "answer") answer = event.content;
          else if (event.type === "error") errorMessage = event.message;
          else if (event.type === "tool" && event.status === "done") {
            toolCalls.push({ name: event.name, ok: event.ok });
          }
        },
        { tools, maxSteps: config.llmMaxSteps, signal: controller.signal },
      );
      if (!answer) {
        const fallback = [...turnResult]
          .reverse()
          .find((m) => m.role === "assistant" && typeof m.content === "string")?.content;
        if (typeof fallback === "string") answer = fallback;
      }
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
    }
  })();

  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve();
    }, opts.timeoutMs);
  });

  await Promise.race([turnPromise, timeoutPromise]);
  if (timer) clearTimeout(timer);
  if (timedOut) controller.abort();

  const durationMs = now() - start;

  if (timedOut) {
    if (opts.json) {
      writeStdout(
        `${JSON.stringify({
          answer: (answer ?? "").trimEnd(),
          error: `timeout after ${opts.timeoutMs}ms`,
          durationMs,
          model: config.llmModel,
          tier,
          toolCalls,
        })}\n`,
      );
    } else {
      if (answer && answer.trim().length > 0) writeStdout(`${answer.trimEnd()}\n`);
      stderrLine(`tdmcp ask: timeout after ${opts.timeoutMs}ms`);
    }
    process.exitCode = 124;
    return;
  }

  if (opts.json) {
    const payload: Record<string, unknown> = {
      answer: (answer ?? "").trimEnd(),
      durationMs,
      model: config.llmModel,
      tier,
      toolCalls,
    };
    if (errorMessage) payload.error = errorMessage;
    writeStdout(`${JSON.stringify(payload)}\n`);
    process.exitCode = errorMessage ? 1 : 0;
    return;
  }

  if (errorMessage && !answer) {
    stderrLine(`tdmcp ask: ${errorMessage}`);
    process.exitCode = 1;
    return;
  }
  if (answer) writeStdout(`${answer.trimEnd()}\n`);
  if (errorMessage) {
    stderrLine(`tdmcp ask: ${errorMessage}`);
    process.exitCode = 1;
  }
}
