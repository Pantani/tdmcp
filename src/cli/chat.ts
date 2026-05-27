import { spawn } from "node:child_process";
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

/**
 * `tdmcp chat` — boots the local LLM copilot: builds the shared tool context,
 * probes the LLM endpoint, starts the loopback chat UI, and opens the browser.
 * Runs until interrupted (Ctrl-C).
 */
export async function runChat(argv: string[] = []): Promise<void> {
  const noOpen = argv.includes("--no-open");
  const config = loadConfig();
  const logger = createLogger(config.logLevel === "silent" ? "silent" : "warn");
  const ctx = buildToolContext(config, { logger });

  const health = await new LlmClient(config).health();
  const handle = await startChatServer(ctx, config);

  process.stdout.write(`\n  tdmcp local copilot → ${handle.url}\n`);
  process.stdout.write(`  model: ${config.llmModel}  ·  endpoint: ${config.llmBaseUrl}\n`);
  if (!health.ok) {
    process.stdout.write(
      `\n  ⚠ LLM endpoint unreachable (${health.detail}).\n` +
        `    Install Ollama from https://ollama.com, then run:  ollama pull ${config.llmModel}\n`,
    );
  } else if (!health.modelReady) {
    process.stdout.write(
      `\n  ⚠ ${health.detail}.\n    Pull it with:  ollama pull ${config.llmModel}\n`,
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
