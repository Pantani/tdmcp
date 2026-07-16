import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The entry point runs `void main()` at import time. We mock every heavy
// dependency so importing `src/index.ts` becomes a thin dispatcher test:
// we control argv, import once, then await a few microtasks so the async
// `main` finishes before assertions.

const originalArgv = process.argv;
const originalEnv = { ...process.env };
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);
const originalExitCode = process.exitCode;

// Captured writes for each test
let stdoutChunks: string[];
let stderrChunks: string[];

const runInstallBridgeMock = vi.fn(async (_args: string[]) => {});
const runInstallClientMock = vi.fn(async (_args: string[]) => {});
const runChatMock = vi.fn(async (_args: string[]) => {});
const runTelegramMock = vi.fn(async (_args: string[]) => {});
const runCopilotCalibrateMock = vi.fn(async (_args: string[]) => 0);
const runManageSkillsCliMock = vi.fn((_args: string[]) => ({
  stdout: "skills-out\n",
  stderr: "",
  code: 0,
}));
const runRuntimeStatusMock = vi.fn(async (_args: string[], _deps: unknown) => ({
  stdout: "status-out\n",
  stderr: "",
  code: 3,
}));
const runShowModeMock = vi.fn(async (_args: string[]) => ({
  stdout: "show-out\n",
  stderr: "show-warning\n",
  code: 4 as const,
}));
const runTopLevelDoctorMock = vi.fn(async (_args: string[]) => ({
  stdout: "doctor-out\n",
  stderr: "",
  code: 1,
}));
const createRuntimeStatusDepsMock = vi.fn(() => ({ readConfig: vi.fn() }));
const runDashboardMock = vi.fn(async (_args: string[]) => 0);
const runPackageCliMock = vi.fn(async (_argv: string[]) => ({
  stdout: "pkg-out",
  stderr: "",
  code: 0,
}));
const isPackageCommandMock = vi.fn((cmd: string | undefined) => cmd === "pkg");
const isKnownPackageDoctorTargetMock = vi.fn((_id: string | undefined) => false);
const renderMainHelpMock = vi.fn(() => "MAIN-HELP");
const resolveMainCompletionCommandMock = vi.fn((_shell: string | undefined) => ({
  stdout: "COMPLETE\n",
  stderr: "",
  exitCode: 0,
}));
const parseServeArgsMock = vi.fn((_argv: string[], _env: NodeJS.ProcessEnv) => ({
  showHelp: false,
  error: undefined as string | undefined,
  loadOptions: {},
}));
const renderServeHelpMock = vi.fn(() => "SERVE-HELP");
const resolveServeInvocationMock = vi.fn((argv: string[]) => ({
  kind: "ok" as const,
  argv,
}));
const startTransportMock = vi.fn(async () => ({
  close: vi.fn(async () => {}),
}));
const createTdmcpServerMock = vi.fn(() => ({}));
const loadConfigMock = vi.fn(() => ({ logLevel: "info" }));
const getVersionMock = vi.fn(() => "9.9.9");

vi.mock("../../src/cli/installBridge.js", () => ({
  runInstallBridge: runInstallBridgeMock,
}));
vi.mock("../../src/cli/installClient.js", () => ({
  runInstallClient: runInstallClientMock,
}));
vi.mock("../../src/cli/chat.js", () => ({
  runChat: runChatMock,
}));
vi.mock("../../src/cli/telegram.js", () => ({
  runTelegram: runTelegramMock,
}));
vi.mock("../../src/cli/copilotCalibrate.js", () => ({
  runCopilotCalibrate: runCopilotCalibrateMock,
}));
vi.mock("../../src/cli/manageSkills.js", () => ({
  runManageSkillsCli: runManageSkillsCliMock,
}));
vi.mock("../../src/cli/runtimeStatus.js", () => ({
  runRuntimeStatus: runRuntimeStatusMock,
}));
vi.mock("../../src/cli/runtimeStatusAdapters.js", () => ({
  createRuntimeStatusDeps: createRuntimeStatusDepsMock,
}));
vi.mock("../../src/cli/showMode.js", () => ({
  runShowMode: runShowModeMock,
}));
vi.mock("../../src/cli/topLevelDoctor.js", () => ({
  runTopLevelDoctor: runTopLevelDoctorMock,
}));
vi.mock("../../src/cli/tui.js", () => ({
  runDashboard: runDashboardMock,
}));
vi.mock("../../src/packages/cli.js", () => ({
  isKnownPackageDoctorTarget: isKnownPackageDoctorTargetMock,
  isPackageCommand: isPackageCommandMock,
  runPackageCli: runPackageCliMock,
}));
vi.mock("../../src/cli/mainHelp.js", () => ({
  renderMainHelp: renderMainHelpMock,
  resolveMainCompletionCommand: resolveMainCompletionCommandMock,
}));
vi.mock("../../src/cli/serverArgs.js", () => ({
  parseServeArgs: parseServeArgsMock,
  renderServeHelp: renderServeHelpMock,
  resolveServeInvocation: resolveServeInvocationMock,
}));
vi.mock("../../src/server/tdmcpServer.js", () => ({
  createTdmcpServer: createTdmcpServerMock,
}));
vi.mock("../../src/server/transportFactory.js", () => ({
  startTransport: startTransportMock,
}));
vi.mock("../../src/utils/config.js", () => ({
  loadConfig: loadConfigMock,
}));
vi.mock("../../src/utils/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));
vi.mock("../../src/utils/version.js", () => ({
  getVersion: getVersionMock,
}));

async function importEntry() {
  // re-execute the module each call so `void main()` runs against the freshly
  // configured argv/env and mocks.
  vi.resetModules();
  await import("../../src/index.js");
  // give the floating `void main()` time to complete
  for (let i = 0; i < 10; i++) await Promise.resolve();
  // small extra wait for any setImmediate-ish work
  await new Promise((r) => setTimeout(r, 5));
}

function setArgv(rest: string[]) {
  process.argv = ["node", "index.js", ...rest];
}

beforeEach(() => {
  stdoutChunks = [];
  stderrChunks = [];
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  process.exitCode = undefined;
  vi.clearAllMocks();
  // restore defaults that some tests override
  runDashboardMock.mockResolvedValue(0);
  runPackageCliMock.mockResolvedValue({ stdout: "pkg-out", stderr: "", code: 0 });
  isPackageCommandMock.mockImplementation((cmd: string | undefined) => cmd === "pkg");
  isKnownPackageDoctorTargetMock.mockReturnValue(false);
  parseServeArgsMock.mockReturnValue({
    showHelp: false,
    error: undefined,
    loadOptions: {},
  });
  resolveServeInvocationMock.mockImplementation((argv: string[]) => ({
    kind: "ok" as const,
    argv,
  }));
  startTransportMock.mockResolvedValue({ close: vi.fn(async () => {}) });
});

afterEach(() => {
  process.argv = originalArgv;
  process.env = { ...originalEnv };
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
  process.exitCode = originalExitCode;
});

describe("src/index.ts dispatcher", () => {
  it("prints main help on --help", async () => {
    setArgv(["--help"]);
    await importEntry();
    expect(stdoutChunks.join("")).toContain("MAIN-HELP");
    expect(renderMainHelpMock).toHaveBeenCalled();
  });

  it("prints version on --version", async () => {
    setArgv(["-v"]);
    await importEntry();
    expect(stdoutChunks.join("")).toContain("9.9.9");
  });

  it("handles completion subcommand", async () => {
    resolveMainCompletionCommandMock.mockReturnValue({
      stdout: "BASHCOMP\n",
      stderr: "warn\n",
      exitCode: 0,
    });
    setArgv(["completion", "bash"]);
    await importEntry();
    expect(stdoutChunks.join("")).toContain("BASHCOMP");
    expect(stderrChunks.join("")).toContain("warn");
    expect(resolveMainCompletionCommandMock).toHaveBeenCalledWith("bash");
  });

  it("delegates install-bridge", async () => {
    setArgv(["install-bridge", "--dry"]);
    await importEntry();
    expect(runInstallBridgeMock).toHaveBeenCalledWith(["--dry"]);
  });

  it("delegates package commands when isPackageCommand matches", async () => {
    isPackageCommandMock.mockReturnValue(true);
    runPackageCliMock.mockResolvedValue({
      stdout: "OUT",
      stderr: "ERR",
      code: 3,
    });
    setArgv(["pkg", "list"]);
    await importEntry();
    expect(stdoutChunks.join("")).toContain("OUT");
    expect(stderrChunks.join("")).toContain("ERR");
    expect(process.exitCode).toBe(3);
  });

  it("delegates install-client via dynamic import", async () => {
    setArgv(["install-client", "claude"]);
    await importEntry();
    expect(runInstallClientMock).toHaveBeenCalledWith(["claude"]);
  });

  it("delegates bounded local skill management", async () => {
    setArgv(["skills", "status", "--host", "codex", "--scope", "project"]);
    await importEntry();
    expect(runManageSkillsCliMock).toHaveBeenCalledWith([
      "status",
      "--host",
      "codex",
      "--scope",
      "project",
    ]);
    expect(stdoutChunks.join("")).toContain("skills-out");
  });

  it("delegates read-only runtime status and preserves its exit code", async () => {
    setArgv(["status", "--json"]);
    await importEntry();
    expect(createRuntimeStatusDepsMock).toHaveBeenCalled();
    expect(runRuntimeStatusMock).toHaveBeenCalledWith(
      ["--json"],
      expect.objectContaining({ readConfig: expect.any(Function) }),
    );
    expect(stdoutChunks.join("")).toContain("status-out");
    expect(process.exitCode).toBe(3);
  });

  it("delegates fail-closed show mode and preserves its structured exit code", async () => {
    setArgv(["show", "venue-a", "--dry-run", "--json"]);
    await importEntry();
    expect(runShowModeMock).toHaveBeenCalledWith(["venue-a", "--dry-run", "--json"]);
    expect(stdoutChunks.join("")).toContain("show-out");
    expect(stderrChunks.join("")).toContain("show-warning");
    expect(process.exitCode).toBe(4);
  });

  it("routes bare doctor to environment diagnostics", async () => {
    setArgv(["doctor", "--json"]);
    await importEntry();
    expect(runTopLevelDoctorMock).toHaveBeenCalledWith(["--json"]);
    expect(stdoutChunks.join("")).toContain("doctor-out");
    expect(process.exitCode).toBe(1);
  });

  it("preserves legacy known-package doctor with a deprecation warning", async () => {
    isKnownPackageDoctorTargetMock.mockReturnValue(true);
    setArgv(["doctor", "raytk", "--json"]);
    await importEntry();
    expect(runPackageCliMock).toHaveBeenCalledWith(["doctor", "raytk", "--json"]);
    expect(stderrChunks.join("")).toContain("Deprecated");
    expect(runTopLevelDoctorMock).not.toHaveBeenCalled();
  });

  it("delegates chat subcommand", async () => {
    setArgv(["chat", "--profile", "x"]);
    await importEntry();
    expect(runChatMock).toHaveBeenCalledWith(["--profile", "x"]);
  });

  it("delegates llm-run subcommand", async () => {
    setArgv(["llm-run", "hello"]);
    await importEntry();
    expect(runChatMock).toHaveBeenCalledWith(["hello"]);
  });

  it("delegates telegram subcommand", async () => {
    setArgv(["telegram", "--once"]);
    await importEntry();
    expect(runTelegramMock).toHaveBeenCalledWith(["--once"]);
  });

  it("delegates sandbox-only local model calibration and preserves its exit code", async () => {
    runCopilotCalibrateMock.mockResolvedValue(3);
    setArgv(["copilot-calibrate", "--json"]);
    await importEntry();
    expect(runCopilotCalibrateMock).toHaveBeenCalledWith(["--json"]);
    expect(process.exitCode).toBe(3);
  });

  it("dashboard subcommand calls process.exit with runDashboard's exit code", async () => {
    runDashboardMock.mockResolvedValue(7);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    setArgv(["dashboard"]);
    await importEntry();
    expect(runDashboardMock).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(7);
    exitSpy.mockRestore();
  });

  it("reports serve invocation parse error to stderr with exit 2", async () => {
    resolveServeInvocationMock.mockReturnValue({
      kind: "error" as const,
      message: "bad flag",
    } as never);
    setArgv(["--bogus"]);
    await importEntry();
    expect(stderrChunks.join("")).toContain("bad flag");
    expect(process.exitCode).toBe(2);
  });

  it("renders serve help when parseServeArgs.showHelp is true", async () => {
    parseServeArgsMock.mockReturnValue({
      showHelp: true,
      error: undefined,
      loadOptions: {},
    });
    setArgv(["--help-serve"]);
    await importEntry();
    expect(stdoutChunks.join("")).toContain("SERVE-HELP");
  });

  it("reports serve parse error and sets exit 2", async () => {
    parseServeArgsMock.mockReturnValue({
      showHelp: false,
      error: "missing --port",
      loadOptions: {},
    });
    setArgv(["--port"]);
    await importEntry();
    expect(stderrChunks.join("")).toContain("missing --port");
    expect(process.exitCode).toBe(2);
  });

  it("boots the server when no subcommand matches and registers signal handlers", async () => {
    const sigSpy = vi.spyOn(process, "on");
    setArgv([]);
    await importEntry();
    expect(loadConfigMock).toHaveBeenCalled();
    expect(startTransportMock).toHaveBeenCalled();
    const events = sigSpy.mock.calls.map((c) => c[0]);
    expect(events).toContain("SIGINT");
    expect(events).toContain("SIGTERM");
    sigSpy.mockRestore();
  });

  it("sets exit code 1 when startTransport throws", async () => {
    startTransportMock.mockRejectedValue(new Error("boot fail"));
    setArgv([]);
    await importEntry();
    expect(process.exitCode).toBe(1);
  });
});
