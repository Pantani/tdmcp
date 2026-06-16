import { runInstallBridge } from "./cli/installBridge.js";
import { renderMainHelp, resolveMainCompletionCommand } from "./cli/mainHelp.js";
import { parseServeArgs, renderServeHelp, resolveServeInvocation } from "./cli/serverArgs.js";
import { isPackageCommand, runPackageCli } from "./packages/cli.js";
import { createTdmcpServer } from "./server/tdmcpServer.js";
import { startTransport } from "./server/transportFactory.js";
import { loadConfig } from "./utils/config.js";
import { createLogger } from "./utils/logger.js";
import { getVersion } from "./utils/version.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(`${renderMainHelp()}\n`);
    return;
  }
  if (argv[0] === "--version" || argv[0] === "-v") {
    process.stdout.write(`${getVersion()}\n`);
    return;
  }
  if (argv[0] === "completion") {
    const result = resolveMainCompletionCommand(argv[1]);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.exitCode !== undefined) process.exitCode = result.exitCode;
    return;
  }
  if (argv[0] === "install-bridge") {
    await runInstallBridge(argv.slice(1));
    return;
  }
  if (argv[0] === "init") {
    const { runInit } = await import("./cli/init.js");
    await runInit(argv.slice(1));
    return;
  }
  if (argv[0] === "ask") {
    const { runAsk } = await import("./cli/ask.js");
    await runAsk(argv.slice(1));
    return;
  }
  if (isPackageCommand(argv[0])) {
    const result = await runPackageCli(argv);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exitCode = result.code;
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
  if (argv[0] === "telegram") {
    const { runTelegram } = await import("./cli/telegram.js");
    await runTelegram(argv.slice(1));
    return;
  }
  if (argv[0] === "creative-rag") {
    const { runCreativeRagCli, toCreativeRagConfig } = await import("./creativeRag/index.js");
    const cfg = loadConfig(process.env, { useFiles: true });
    process.exitCode = await runCreativeRagCli(argv.slice(1), { config: toCreativeRagConfig(cfg) });
    return;
  }
  if (argv[0] === "dashboard") {
    const { runDashboard } = await import("./cli/tui.js");
    process.exit(await runDashboard(argv.slice(1)));
  }

  // The server honors a saved config file too (tdmcp.json / .tdmcprc / ~/.config/tdmcp);
  // pick a profile via TDMCP_PROFILE. Env vars still win over the file.
  const serveInvocation = resolveServeInvocation(argv);
  if (serveInvocation.kind === "error") {
    process.stderr.write(`${serveInvocation.message}\n`);
    process.exitCode = 2;
    return;
  }
  const serveArgs = parseServeArgs(serveInvocation.argv, process.env);
  if (serveArgs.showHelp) {
    process.stdout.write(`${renderServeHelp()}\n`);
    return;
  }
  if (serveArgs.error) {
    process.stderr.write(`${serveArgs.error}\n`);
    process.exitCode = 2;
    return;
  }
  const config = loadConfig(process.env, serveArgs.loadOptions);
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
