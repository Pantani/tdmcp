import { runInstallBridge } from "./cli/installBridge.js";
import { createTdmcpServer } from "./server/tdmcpServer.js";
import { startTransport } from "./server/transportFactory.js";
import { loadConfig } from "./utils/config.js";
import { createLogger } from "./utils/logger.js";
import { getVersion } from "./utils/version.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "--version" || argv[0] === "-v") {
    process.stdout.write(`${getVersion()}\n`);
    return;
  }
  if (argv[0] === "install-bridge") {
    runInstallBridge(argv.slice(1));
    return;
  }
  if (argv[0] === "install") {
    const { runInstall } = await import("./cli/install.js");
    await runInstall(argv.slice(1));
    return;
  }
  if (argv[0] === "install-client") {
    const { runInstallClient } = await import("./cli/installClient.js");
    await runInstallClient(argv.slice(1));
    return;
  }
  if (argv[0] === "chat" || argv[0] === "llm-run") {
    const { runChat } = await import("./cli/chat.js");
    await runChat(argv.slice(1));
    return;
  }

  const config = loadConfig();
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
