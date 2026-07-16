import { runInstallBridge } from "./cli/installBridge.js";
import { renderMainHelp, resolveMainCompletionCommand } from "./cli/mainHelp.js";
import { parseServeArgs, renderServeHelp, resolveServeInvocation } from "./cli/serverArgs.js";
import { isKnownPackageDoctorTarget, isPackageCommand, runPackageCli } from "./packages/cli.js";
import { createTdmcpServer } from "./server/tdmcpServer.js";
import { startTransport } from "./server/transportFactory.js";
import { loadConfig } from "./utils/config.js";
import { createLogger } from "./utils/logger.js";
import { getVersion } from "./utils/version.js";

type LocalCommandHandler = (args: string[]) => Promise<void>;

const LOCAL_COMMANDS: Record<string, LocalCommandHandler> = {
  "install-client": async (args) => {
    const { runInstallClient } = await import("./cli/installClient.js");
    await runInstallClient(args);
  },
  skills: async (args) => {
    const { runManageSkillsCli } = await import("./cli/manageSkills.js");
    const result = runManageSkillsCli(args);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exitCode = result.code;
  },
  status: async (args) => {
    const [{ runRuntimeStatus }, { createRuntimeStatusDeps }] = await Promise.all([
      import("./cli/runtimeStatus.js"),
      import("./cli/runtimeStatusAdapters.js"),
    ]);
    const result = await runRuntimeStatus(args, createRuntimeStatusDeps());
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exitCode = result.code;
  },
  show: async (args) => {
    const { runShowMode } = await import("./cli/showMode.js");
    writeLocalResult(await runShowMode(args));
  },
  "copilot-calibrate": async (args) => {
    const { runCopilotCalibrate } = await import("./cli/copilotCalibrate.js");
    process.exitCode = await runCopilotCalibrate(args);
  },
};

async function runLocalCommand(argv: string[]): Promise<boolean> {
  const handler = LOCAL_COMMANDS[argv[0] ?? ""];
  if (!handler) return false;
  await handler(argv.slice(1));
  return true;
}

function writeLocalResult(result: { stdout: string; stderr: string; code: number }): void {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.code;
}

async function runDoctorCommand(argv: string[]): Promise<void> {
  if (isKnownPackageDoctorTarget(argv[1])) {
    process.stderr.write(
      "Deprecated: use `tdmcp packages doctor [package]`; bare `tdmcp doctor` now diagnoses the environment.\n",
    );
    writeLocalResult(await runPackageCli(argv));
    return;
  }
  const { runTopLevelDoctor } = await import("./cli/topLevelDoctor.js");
  writeLocalResult(await runTopLevelDoctor(argv.slice(1)));
}

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
  if (argv[0] === "doctor") {
    await runDoctorCommand(argv);
    return;
  }
  if (isPackageCommand(argv[0])) {
    writeLocalResult(await runPackageCli(argv));
    return;
  }
  if (await runLocalCommand(argv)) return;
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
    process.exitCode = await runCreativeRagCli(argv.slice(1), {
      config: toCreativeRagConfig(cfg),
      projectRagEnabled: cfg.ragEnabled === true && cfg.projectRagEnabled === true,
    });
    return;
  }
  if (argv[0] === "project-rag") {
    const { runProjectRagCli, toProjectRagConfig } = await import("./projectRag/index.js");
    const cfg = loadConfig(process.env, { useFiles: true });
    process.exitCode = await runProjectRagCli(argv.slice(1), { config: toProjectRagConfig(cfg) });
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
