import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { LlmClient } from "../llm/client.js";
import { startChatServer } from "../llm/server.js";
import { buildToolContext } from "../server/context.js";
import { loadConfig } from "../utils/config.js";
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

const HELP = `tdmcp chat — local LLM copilot in your browser (alias: tdmcp llm-run)

Usage: tdmcp chat [flags]

Flags:
  --no-ollama   Don't auto-start Ollama; assume the endpoint is already running.
  --no-open     Don't open the browser automatically.
  -h, --help    Show this help.

By default, if the configured endpoint is local Ollama and it isn't running,
tdmcp chat starts it for you and leaves it running. Configure the model and
endpoint with TDMCP_LLM_MODEL / TDMCP_LLM_BASE_URL, or live from the UI.`;

/**
 * `tdmcp chat` — boots the local LLM copilot: ensures Ollama is up (unless
 * --no-ollama), builds the shared tool context, starts the loopback chat UI, and
 * opens the browser. Runs until interrupted (Ctrl-C).
 */
export async function runChat(argv: string[] = []): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  const noOpen = argv.includes("--no-open");
  const autoStart = !argv.includes("--no-ollama");
  const config = loadConfig();
  const logger = createLogger(config.logLevel === "silent" ? "silent" : "warn");
  const ctx = buildToolContext(config, { logger });
  const client = new LlmClient(config);
  const log = (msg: string) => process.stdout.write(`${msg}\n`);

  process.stdout.write("\n");
  await ensureOllamaUp(client, config.llmBaseUrl, autoStart, log);

  const handle = await startChatServer(ctx, config);
  const health = await client.health();

  process.stdout.write(`\n  tdmcp local copilot → ${handle.url}\n`);
  process.stdout.write(`  model: ${config.llmModel}  ·  endpoint: ${config.llmBaseUrl}\n`);
  if (!health.ok) {
    process.stdout.write(
      `\n  ⚠ LLM endpoint unreachable (${health.detail}).\n` +
        (autoStart
          ? "    Install Ollama from https://ollama.com, then re-run `tdmcp chat`.\n"
          : "    Auto-start is off (--no-ollama) — start it yourself: ollama serve\n"),
    );
  } else if (!health.modelReady) {
    process.stdout.write(
      `\n  ⚠ ${health.detail}.\n    Pull it with:  ollama pull ${config.llmModel}  (or use the button in the UI)\n`,
    );
  } else {
    process.stdout.write(`  status: ${health.detail}\n`);
  }
  process.stdout.write("\n  Press Ctrl-C to stop.\n\n");

  if (!noOpen) openBrowser(handle.url);

  await new Promise<void>((resolve) => {
    const stop = () => {
      void handle.close().finally(() => resolve());
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
