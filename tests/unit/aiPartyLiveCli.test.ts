import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const serviceMocks = vi.hoisted(() => ({
  config: {
    eventLogPath: "/tmp/tdmcp-ai-party-events.jsonl",
    telegramPollingEnabled: false,
  },
  triggerCue: vi.fn(),
  processOperatorText: vi.fn(),
  approveApproval: vi.fn(),
  snapshot: vi.fn(),
  start: vi.fn(),
  close: vi.fn(),
  tdBuild: vi.fn(),
  createAiPartyLiveService: vi.fn(),
}));

vi.mock("../../src/automation/aiPartyLive/service.js", () => ({
  configFromEnv: vi.fn(() => serviceMocks.config),
  createAiPartyLiveService: serviceMocks.createAiPartyLiveService,
}));

const { runAiPartyLiveCli } = await import("../../src/automation/aiPartyLive/cli.js");

function written(spy: ReturnType<typeof vi.spyOn>): string {
  const calls = spy.mock.calls as Array<[unknown, ...unknown[]]>;
  return calls.map((call) => String(call[0])).join("");
}

describe("runAiPartyLiveCli", () => {
  let stdout: ReturnType<typeof vi.spyOn>;
  let stderr: ReturnType<typeof vi.spyOn>;
  let sigintListeners: NodeJS.SignalsListener[];
  let sigtermListeners: NodeJS.SignalsListener[];
  const originalExitCode = process.exitCode;

  beforeEach(() => {
    sigintListeners = process.listeners("SIGINT") as NodeJS.SignalsListener[];
    sigtermListeners = process.listeners("SIGTERM") as NodeJS.SignalsListener[];
    process.exitCode = undefined;
    stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    serviceMocks.triggerCue.mockReset();
    serviceMocks.processOperatorText.mockReset();
    serviceMocks.approveApproval.mockReset();
    serviceMocks.snapshot.mockReset();
    serviceMocks.start.mockReset();
    serviceMocks.close.mockReset();
    serviceMocks.tdBuild.mockReset();
    serviceMocks.createAiPartyLiveService.mockReset();
    serviceMocks.createAiPartyLiveService.mockReturnValue({
      triggerCue: serviceMocks.triggerCue,
      processOperatorText: serviceMocks.processOperatorText,
      approveApproval: serviceMocks.approveApproval,
      snapshot: serviceMocks.snapshot,
      start: serviceMocks.start,
      tdBuild: serviceMocks.tdBuild,
    });
  });

  afterEach(() => {
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
    for (const listener of sigintListeners) process.on("SIGINT", listener);
    for (const listener of sigtermListeners) process.on("SIGTERM", listener);
    process.exitCode = originalExitCode;
    stdout.mockRestore();
    stderr.mockRestore();
  });

  it("runs the dry demo and prints a structured summary", async () => {
    serviceMocks.triggerCue
      .mockResolvedValueOnce({ cue: "doors_idle" })
      .mockResolvedValueOnce({ cue: "brand_hero" })
      .mockResolvedValueOnce({ cue: "audio_reactive_main" });
    serviceMocks.processOperatorText
      .mockResolvedValueOnce({ intent: "mood" })
      .mockResolvedValueOnce({ approval: { id: "approval-1" } })
      .mockResolvedValueOnce({ blocked: true });
    serviceMocks.approveApproval.mockResolvedValue({ approved: true });
    serviceMocks.snapshot.mockReturnValue({
      approvals: [{ id: "approval-1", status: "approved" }],
      events: [{ type: "cue" }, { type: "approval" }],
      showState: {
        current_cue: "audio_reactive_main",
        hardware_enabled: false,
        dmx_live_enabled: false,
      },
    });

    await runAiPartyLiveCli(["dry"]);

    expect(serviceMocks.createAiPartyLiveService).toHaveBeenCalledWith({
      ...serviceMocks.config,
      dashboardPort: 0,
    });
    expect(serviceMocks.approveApproval).toHaveBeenCalledWith("approval-1", "front-of-house");
    const output = written(stdout);
    expect(output).toContain("Live Nervous System dry-run complete");
    expect(output).toContain('"dryRun": true');
    expect(output).toContain('"current_cue": "audio_reactive_main"');
  });

  it("starts the dashboard in dev mode without enabling Telegram polling", async () => {
    serviceMocks.start.mockResolvedValue({
      url: "http://127.0.0.1:4123",
      close: serviceMocks.close,
    });

    await runAiPartyLiveCli(["dev"]);

    expect(serviceMocks.createAiPartyLiveService).toHaveBeenCalledWith({
      ...serviceMocks.config,
      telegramPollingEnabled: false,
    });
    expect(written(stdout)).toContain("Live Nervous System dashboard: http://127.0.0.1:4123");
  });

  it("enables Telegram polling for the telegram command", async () => {
    serviceMocks.start.mockResolvedValue({
      url: "http://127.0.0.1:4124",
      close: serviceMocks.close,
    });

    await runAiPartyLiveCli(["telegram"]);

    expect(serviceMocks.createAiPartyLiveService).toHaveBeenCalledWith({
      ...serviceMocks.config,
      telegramPollingEnabled: true,
    });
  });

  it("prints the TouchDesigner build report and maps failure to exit code 2", async () => {
    serviceMocks.tdBuild.mockResolvedValue({ ok: false, reason: "bridge offline" });

    await runAiPartyLiveCli(["td-build"]);

    expect(process.exitCode).toBe(2);
    expect(written(stdout)).toContain('"reason": "bridge offline"');
  });

  it("rejects unknown commands", async () => {
    await runAiPartyLiveCli(["wat"]);

    expect(process.exitCode).toBe(2);
    expect(written(stderr)).toContain("Unknown ai-party-live command: wat");
  });
});
