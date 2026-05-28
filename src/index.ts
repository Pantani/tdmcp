import { runInstallBridge } from "./cli/installBridge.js";
import { createTdmcpServer } from "./server/tdmcpServer.js";
import { startTransport } from "./server/transportFactory.js";
import { loadConfig } from "./utils/config.js";
import { createLogger } from "./utils/logger.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "install-bridge") {
    runInstallBridge(argv.slice(1));
    return;
  }
  if (argv[0] === "install") {
    const { runInstall } = await import("./cli/install.js");
    await runInstall(argv.slice(1));
    return;
  }
  if (argv[0] === "chat" || argv[0] === "llm-run") {
    const { runChat } = await import("./cli/chat.js");
    await runChat(argv.slice(1));
    return;
  }

  // The server honors a saved config file too (tdmcp.json / .tdmcprc / ~/.config/tdmcp);
  // pick a profile via TDMCP_PROFILE. Env vars still win over the file.
  const config = loadConfig(process.env, { useFiles: true, profile: process.env.TDMCP_PROFILE });
  const logger = createLogger(config.logLevel);

  try {
    const handle = await startTransport(
      () => createTdmcpServer(config, { logger }),
      config,
      logger,
    );

    const shutdown = () => {
      logger.info("tdmcp shutting down");
      void handle.close().finally(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } catch (err) {
    logger.error("Failed to start tdmcp server", { error: String(err) });
    process.exitCode = 1;
  }
}

void main();
