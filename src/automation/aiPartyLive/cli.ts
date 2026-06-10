import { pathToFileURL } from "node:url";
import { configFromEnv, createAiPartyLiveService } from "./service.js";

async function runDry(): Promise<void> {
  const service = createAiPartyLiveService({ ...configFromEnv(), dashboardPort: 0 });
  const steps: unknown[] = [];

  steps.push(await service.triggerCue("doors_idle"));
  steps.push(
    await service.processOperatorText("deixa a sala mais premium tropical", "demo_script"),
  );
  steps.push(await service.triggerCue("brand_hero"));
  const fog = await service.processOperatorText(
    "prepara uma entrada curta de fumaça no próximo drop",
    "demo_script",
  );
  steps.push(fog);
  if (fog.approval?.id)
    steps.push(await service.approveApproval(fog.approval.id, "front-of-house"));
  steps.push(await service.triggerCue("audio_reactive_main"));
  steps.push(
    await service.processOperatorText("blackout total e strobo máximo e raw dmx", "demo_script"),
  );

  const snapshot = service.snapshot();
  const summary = {
    dryRun: true,
    steps: steps.length,
    pending_approvals: snapshot.approvals.filter((approval) => approval.status === "pending")
      .length,
    approvals: snapshot.approvals.length,
    events: snapshot.events.length,
    current_cue: snapshot.showState.current_cue,
    hardware_enabled: snapshot.showState.hardware_enabled,
    dmx_live_enabled: snapshot.showState.dmx_live_enabled,
    event_log_path: configFromEnv().eventLogPath,
  };
  process.stdout.write("Live Nervous System dry-run complete\n");
  process.stdout.write(`Current cue: ${summary.current_cue}\n`);
  process.stdout.write(`Events: ${summary.events}\n`);
  process.stdout.write(`${JSON.stringify({ summary, snapshot }, null, 2)}\n`);
}

async function runDev(telegram = false): Promise<void> {
  const cfg = configFromEnv();
  const service = createAiPartyLiveService({
    ...cfg,
    telegramPollingEnabled: telegram || cfg.telegramPollingEnabled,
  });
  const handle = await service.start();
  process.stdout.write(`Live Nervous System dashboard: ${handle.url}\n`);
  process.stdout.write(`Event log: ${cfg.eventLogPath}\n`);
  process.stdout.write("Press Ctrl+C to stop.\n");
  const shutdown = () => {
    void handle.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function runTdBuild(): Promise<void> {
  const service = createAiPartyLiveService(configFromEnv());
  const report = await service.tdBuild();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.ok ? 0 : 2;
}

export async function runAiPartyLiveCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const command = argv[0] ?? "dev";
  if (command === "dev") {
    await runDev(false);
    return;
  }
  if (command === "telegram") {
    await runDev(true);
    return;
  }
  if (command === "dry") {
    await runDry();
    return;
  }
  if (command === "td-build") {
    await runTdBuild();
    return;
  }
  process.stderr.write(`Unknown ai-party-live command: ${command}\n`);
  process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runAiPartyLiveCli().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
