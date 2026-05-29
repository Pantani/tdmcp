import { runInstallBridge } from "./cli/installBridge.js";
import { isPackageCommand, runPackageCli } from "./packages/cli.js";
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
  if (isPackageCommand(argv[0])) {
    const result = await runPackageCli(argv);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exitCode = result.code;
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
