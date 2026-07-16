import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  type RuntimeStatusReport,
  RuntimeStatusReportSchema,
} from "../../src/cli/runtimeStatus.js";
import { runShowMode, type ShowModeDeps, showModeResultSchema } from "../../src/cli/showMode.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import type { TdEditorContext, TdPerformModeState } from "../../src/td-client/validators.js";
import type { ToolContext } from "../../src/tools/types.js";
import { loadConfig, type TdmcpConfig } from "../../src/utils/config.js";

const PROFILE = "venue-main";
const BASE = "http://127.0.0.1:9980";
const SECRET = "show-mode-secret-canary";

function runtimeReport(
  overrides: {
    profile?: string | null;
    endpoint?: string;
    config?: "available" | "unavailable" | "unknown";
    bridge?: "available" | "unavailable" | "unknown";
    health?: "healthy" | "degraded" | "unhealthy" | "unknown";
    td?: "available" | "unavailable" | "unknown";
    project?: boolean | null;
    perform?: boolean | null;
    ui?: "available" | "unavailable" | "unknown";
    warnings?: number;
  } = {},
): RuntimeStatusReport {
  const warningCount = overrides.warnings ?? 0;
  return RuntimeStatusReportSchema.parse({
    schema_version: 1,
    generated_at: "2026-07-15T12:00:00.000Z",
    readiness: "ready",
    config: {
      state: overrides.config ?? "available",
      reason_code: "none",
      profile: overrides.profile === undefined ? PROFILE : overrides.profile,
      source_kind: "explicit",
      transport: "stdio",
      bridge_endpoint: overrides.endpoint ?? BASE,
      mcp_endpoint: null,
      http_auth_mode: "none",
      request_timeout_ms: 1_500,
      bridge_token: "configured",
      mcp_http_token: "absent",
    },
    bridge: {
      state: overrides.bridge ?? "available",
      reason_code: "none",
      health: overrides.health ?? "healthy",
      bridge_version: "0.13.1",
      expected_bridge_version: "0.13.1",
      version_state: "match",
      latency_ms: 4,
      heartbeat_stale: false,
    },
    touchdesigner: {
      state: overrides.td ?? "available",
      reason_code: "none",
      version: "2025.32820",
      build: { state: "available", value: "2025.32820" },
      project: { state: "available", present: overrides.project ?? true },
      perform_mode: overrides.perform === undefined ? false : overrides.perform,
      ui: { state: overrides.ui ?? "available", active_network_editor: true },
    },
    policy: {
      state: "available",
      reason_code: "none",
      tool_profile: "safe",
      raw_python_tool_surface: "disabled",
      bridge_allow_exec: "disabled",
      yolo_confirmation_skip: "disabled",
      delete_default: "native_fail_closed",
      save_overwrite_default: "native_fail_closed",
    },
    interactions: {
      state: "available",
      reason_code: "none",
      broker: "available",
      native_ui: "available",
      pending_count: 0,
      pending_limit: 3,
      active: false,
      fail_closed_choice: "Keep",
    },
    skills: {
      state: "available",
      reason_code: "none",
      source_version: "0.13.1",
      owned_namespace: "tdmcp",
      expected_count: 0,
      installed_count: 0,
      installations: [],
    },
    clients: {
      state: "available",
      reason_code: "none",
      observations: [
        {
          client: "claude",
          scope: "project",
          state: "available",
          registration: "registered",
          command_matches: true,
          endpoint_matches: true,
          token_presence: "configured",
        },
        {
          client: "claude",
          scope: "user",
          state: "available",
          registration: "not_registered",
          command_matches: null,
          endpoint_matches: null,
          token_presence: "absent",
        },
        {
          client: "cursor",
          scope: "project",
          state: "available",
          registration: "not_registered",
          command_matches: null,
          endpoint_matches: null,
          token_presence: "absent",
        },
        {
          client: "cursor",
          scope: "user",
          state: "available",
          registration: "not_registered",
          command_matches: null,
          endpoint_matches: null,
          token_presence: "absent",
        },
        {
          client: "codex",
          scope: "user",
          state: "available",
          registration: "registered",
          command_matches: true,
          endpoint_matches: true,
          token_presence: "configured",
        },
      ],
    },
    warnings: Array.from({ length: warningCount }, () => ({
      code: "bridge_version_mismatch",
      message: `private ${SECRET}`,
    })),
  });
}

function editor(performMode: boolean | null): TdEditorContext {
  return {
    project: { name: "show", folder: "/shows", save_version: null, save_build: "2025" },
    touchdesigner: { build: "2025", version: "2025" },
    perform_mode: performMode,
    ui_available: performMode !== true,
    panes: [],
    active_network_editor: null,
    warnings: [],
  };
}

function write(enabled: boolean): TdPerformModeState {
  return {
    enabled,
    was: !enabled,
    stored: true,
    ui_perform_mode_set: true,
    project_perform_mode_set: false,
    warnings: [],
  };
}

function context(reads: Array<boolean | null | Error> = [false, false]) {
  const getEditorContext = vi.fn(async () => {
    const value = reads.shift();
    if (value instanceof Error) throw value;
    return editor(value ?? null);
  });
  const setPerformMode = vi.fn(async (enabled: boolean) => write(enabled));
  return {
    value: { client: { getEditorContext, setPerformMode } } as unknown as ToolContext,
    getEditorContext,
    setPerformMode,
  };
}

function config(port = 9980): TdmcpConfig {
  return { ...loadConfig({}), tdHost: "127.0.0.1", tdPort: port, requestTimeoutMs: 1_500 };
}

function doctorReport(
  checks: Array<{ status: "pass" | "warn" | "fail"; critical: boolean }> = [
    { status: "pass", critical: true },
  ],
  endpoint = BASE,
) {
  return {
    ok: !checks.some((check) => check.critical && check.status === "fail"),
    checks: checks.map((check, index) => ({
      id: `doctor_${index}`,
      title: `Doctor ${index}`,
      ...check,
      detail: `Bearer ${SECRET}`,
    })),
    config: {
      tdBaseUrl: endpoint,
      llmBaseUrl: `http://${SECRET}`,
      llmModel: SECRET,
      chatPort: 3260,
      vaultPath: `/private/${SECRET}`,
    },
  };
}

function preflight(statuses: Array<"pass" | "warn" | "unverified" | "fail"> = ["pass"]) {
  const checks = statuses.map((status, index) => ({
    id: `preflight_${index}`,
    status,
    message: status === "pass" ? "Ready." : `Bearer ${SECRET}`,
    data: { topology: Array.from({ length: 500 }, () => SECRET) },
  }));
  return {
    status: statuses.includes("fail")
      ? "fail"
      : statuses.includes("warn")
        ? "warn"
        : statuses.includes("unverified")
          ? "unverified"
          : "pass",
    root_path: "/project1",
    target_fps: 60,
    summary: {
      pass: statuses.filter((status) => status === "pass").length,
      unverified: statuses.filter((status) => status === "unverified").length,
      warn: statuses.filter((status) => status === "warn").length,
      fail: statuses.filter((status) => status === "fail").length,
    },
    checks,
  } as const;
}

function deps(
  options: {
    runtime?: RuntimeStatusReport;
    doctor?: ReturnType<typeof doctorReport>;
    preflight?: ReturnType<typeof preflight>;
    ctx?: ReturnType<typeof context>;
    loadedConfig?: TdmcpConfig;
  } = {},
) {
  const ctx = options.ctx ?? context();
  const loadedConfig = options.loadedConfig ?? config();
  const injected: Partial<ShowModeDeps> = {
    env: { TDMCP_PROFILE: "wrong-environment-default" },
    cwd: "/workspace",
    createRuntimeStatusDeps: vi.fn(() => ({ readConfig: vi.fn() })),
    runRuntimeStatus: vi.fn(async () => ({
      stdout: "",
      stderr: "",
      code: 0 as const,
      report: options.runtime ?? runtimeReport(),
    })),
    loadConfig: vi.fn(() => loadedConfig),
    buildToolContext: vi.fn(() => ctx.value),
    runDoctor: vi.fn(async () => ({
      stdout: JSON.stringify(options.doctor ?? doctorReport()),
      stderr: "",
      code: options.doctor?.ok === false ? 1 : 0,
    })),
    runPreflight: vi.fn(async () => ({
      content: [{ type: "text" as const, text: "preflight" }],
      structuredContent: options.preflight ?? preflight(),
    })),
  };
  return { injected, ctx };
}

describe("runShowMode parser and binding", () => {
  it("returns help without resolving config or touching the bridge", async () => {
    const fixture = deps();
    const result = await runShowMode(["--help"], fixture.injected);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain("tdmcp show <profile>");
    expect(fixture.injected.runRuntimeStatus).not.toHaveBeenCalled();
    expect(fixture.injected.loadConfig).not.toHaveBeenCalled();
  });

  it.each([
    [],
    [PROFILE, "other"],
    [PROFILE, "--unknown"],
    [PROFILE, "--fix"],
    ["--profile", PROFILE],
    ["bad\nprofile"],
    [PROFILE, "--config="],
    [PROFILE, "--config", "one", "--config", "two"],
    [PROFILE, "--root-path", "project1"],
    [PROFILE, "--root-path", "/project1/../secret"],
    [PROFILE, "--target-fps", "0"],
    [PROFILE, "--target-fps", "Infinity"],
    [PROFILE, "--timeout-ms", "99"],
    [PROFILE, "--timeout-ms", "5001"],
    [PROFILE, "--host", "127.0.0.1"],
    [PROFILE, "--token", SECRET],
  ])("rejects invalid arguments without side effects: %j", async (...argv: unknown[]) => {
    const fixture = deps();
    const result = await runShowMode(argv as string[], fixture.injected);
    expect(result.code).toBe(2);
    expect(fixture.injected.runRuntimeStatus).not.toHaveBeenCalled();
    expect(fixture.injected.loadConfig).not.toHaveBeenCalled();
    expect(fixture.ctx.setPerformMode).not.toHaveBeenCalled();
  });

  it("binds status, doctor, config and one context to the exact positional profile", async () => {
    const fixture = deps();
    const result = await runShowMode(
      [
        PROFILE,
        "--config",
        "/safe/tdmcp.json",
        "--root-path",
        "/project1/show",
        "--target-fps",
        "50",
        "--timeout-ms",
        "800",
        "--dry-run",
      ],
      fixture.injected,
    );
    expect(result.code).toBe(0);
    expect(fixture.injected.runRuntimeStatus).toHaveBeenCalledWith(
      ["--json", "--profile", PROFILE, "--config", "/safe/tdmcp.json", "--timeout-ms", "800"],
      expect.any(Object),
    );
    expect(fixture.injected.loadConfig).toHaveBeenCalledWith(
      expect.objectContaining({ TDMCP_PROFILE: "wrong-environment-default" }),
      expect.objectContaining({
        useFiles: true,
        profile: PROFILE,
        configPath: "/safe/tdmcp.json",
        cwd: "/workspace",
        overrides: { requestTimeoutMs: 800 },
      }),
    );
    expect(fixture.injected.buildToolContext).toHaveBeenCalledOnce();
    expect(fixture.injected.runDoctor).toHaveBeenCalledWith(
      ["--json", "--profile", PROFILE, "--config", "/safe/tdmcp.json"],
      expect.objectContaining({ context: fixture.ctx.value }),
    );
    expect(fixture.injected.runPreflight).toHaveBeenCalledWith(fixture.ctx.value, {
      root_path: "/project1/show",
      target_fps: 50,
      recursive: true,
      include_displays: true,
      include_performance: true,
    });
    expect(fixture.ctx.setPerformMode).not.toHaveBeenCalled();
  });
});

describe("runShowMode fail-closed gates", () => {
  it.each([
    ["profile mismatch", runtimeReport({ profile: "other" })],
    ["config missing", runtimeReport({ config: "unavailable" })],
    ["bridge missing", runtimeReport({ bridge: "unavailable" })],
    ["TouchDesigner missing", runtimeReport({ td: "unavailable" })],
    ["project missing", runtimeReport({ project: false })],
    ["unhealthy bridge", runtimeReport({ health: "unhealthy" })],
    ["perform unknown", runtimeReport({ perform: null })],
    ["endpoint mismatch", runtimeReport({ endpoint: "http://127.0.0.1:9999" })],
  ])("blocks %s even with both overrides", async (_name, runtime) => {
    const fixture = deps({ runtime });
    const result = await runShowMode(
      [PROFILE, "--allow-warn", "--allow-unverified"],
      fixture.injected,
    );
    expect(result.code).not.toBe(0);
    expect(fixture.ctx.setPerformMode).not.toHaveBeenCalled();
  });

  it("blocks critical doctor failures and every preflight fail", async () => {
    const fixture = deps({
      doctor: doctorReport([{ status: "fail", critical: true }]),
      preflight: preflight(["fail"]),
    });
    const result = await runShowMode(
      [PROFILE, "--allow-warn", "--allow-unverified"],
      fixture.injected,
    );
    expect(result).toMatchObject({ code: 3, report: { overall: "FAIL" } });
    expect(fixture.ctx.setPerformMode).not.toHaveBeenCalled();
  });

  it("keeps warning and unverified overrides separate and requires both for mixed evidence", async () => {
    const run = (flags: string[]) => {
      const fixture = deps({ preflight: preflight(["warn", "unverified"]) });
      return { fixture, pending: runShowMode([PROFILE, "--dry-run", ...flags], fixture.injected) };
    };

    await expect(run([]).pending).resolves.toMatchObject({ code: 3 });
    await expect(run(["--allow-warn"]).pending).resolves.toMatchObject({ code: 4 });
    await expect(run(["--allow-unverified"]).pending).resolves.toMatchObject({ code: 3 });
    await expect(run(["--allow-warn", "--allow-unverified"]).pending).resolves.toMatchObject({
      code: 0,
      report: { overall: "PASS", dry_run: true },
    });
  });

  it("blocks disagreement between the status snapshot and independent readback", async () => {
    const fixture = deps({ ctx: context([true]) });
    const result = await runShowMode(
      [PROFILE, "--allow-warn", "--allow-unverified"],
      fixture.injected,
    );
    expect(result).toMatchObject({ code: 4, report: { overall: "UNVERIFIED" } });
    expect(fixture.ctx.setPerformMode).not.toHaveBeenCalled();
  });
});

describe("runShowMode mutation and rollback", () => {
  it("enters once, reads back once and reports confirmed state", async () => {
    const fixture = deps({ ctx: context([false, true]) });
    const result = await runShowMode([PROFILE, "--json"], fixture.injected);
    expect(result).toMatchObject({
      code: 0,
      report: {
        overall: "PASS",
        perform_before: false,
        perform_after: true,
        action_applied: "entered",
        rollback: { status: "not_needed" },
      },
    });
    expect(fixture.ctx.setPerformMode).toHaveBeenCalledTimes(1);
    expect(fixture.ctx.setPerformMode).toHaveBeenCalledWith(true);
    expect(fixture.ctx.getEditorContext).toHaveBeenCalledTimes(2);
    expect(fixture.ctx.getEditorContext).toHaveBeenNthCalledWith(1, {
      timeoutMs: 1_500,
      retry: false,
    });
    expect(showModeResultSchema.parse(JSON.parse(result.stdout))).toEqual(result.report);
  });

  it("runs all gates but never writes when already in Perform Mode", async () => {
    const fixture = deps({ runtime: runtimeReport({ perform: true }), ctx: context([true]) });
    const result = await runShowMode([PROFILE], fixture.injected);
    expect(result).toMatchObject({
      code: 0,
      report: {
        already_perform: true,
        perform_before: true,
        perform_after: true,
        action_applied: "none",
      },
    });
    expect(fixture.injected.runDoctor).toHaveBeenCalledOnce();
    expect(fixture.injected.runPreflight).toHaveBeenCalledOnce();
    expect(fixture.ctx.setPerformMode).not.toHaveBeenCalled();
  });

  it("does not own or alter a pre-existing Perform Mode state when a gate fails", async () => {
    const fixture = deps({
      runtime: runtimeReport({ perform: true }),
      ctx: context([true]),
      preflight: preflight(["fail"]),
    });
    const result = await runShowMode([PROFILE], fixture.injected);
    expect(result).toMatchObject({
      code: 3,
      report: { perform_before: true, already_perform: true, action_applied: "none" },
    });
    expect(result.stdout).toContain("not owned or changed");
    expect(fixture.ctx.setPerformMode).not.toHaveBeenCalled();
  });

  it.each([
    "throw",
    "malformed",
    "false_report",
    "false_readback",
    "readback_error",
  ])("attempts one OFF rollback and no second enter after %s", async (failure) => {
    const fixture = deps({
      ctx: context(
        failure === "false_readback"
          ? [false, false, false]
          : failure === "readback_error"
            ? [false, new Error("lost response"), false]
            : [false, false],
      ),
    });
    if (failure === "throw") {
      fixture.ctx.setPerformMode
        .mockRejectedValueOnce(new Error("timeout"))
        .mockResolvedValueOnce(write(false));
    } else if (failure === "malformed") {
      fixture.ctx.setPerformMode
        .mockResolvedValueOnce({ enabled: true } as TdPerformModeState)
        .mockResolvedValueOnce(write(false));
    } else if (failure === "false_report") {
      fixture.ctx.setPerformMode
        .mockResolvedValueOnce({ ...write(true), stored: false })
        .mockResolvedValueOnce(write(false));
    }
    const result = await runShowMode([PROFILE], fixture.injected);
    expect(result).toMatchObject({
      code: 3,
      report: {
        overall: "FAIL",
        perform_after: false,
        action_applied: "rolled_back",
        rollback: { status: "pass" },
      },
    });
    expect(fixture.ctx.setPerformMode).toHaveBeenCalledTimes(2);
    expect(fixture.ctx.setPerformMode.mock.calls).toEqual([[true], [false]]);
  });

  it("reports failed and unverified rollback states without a third mutation", async () => {
    const failed = deps({ ctx: context([false, false, true]) });
    const failedResult = await runShowMode([PROFILE], failed.injected);
    expect(failedResult).toMatchObject({
      code: 3,
      report: { rollback: { status: "fail" }, perform_after: true, action_applied: "none" },
    });
    expect(failed.ctx.setPerformMode).toHaveBeenCalledTimes(2);

    const unknown = deps({ ctx: context([false, false, new Error("disconnect")]) });
    const unknownResult = await runShowMode([PROFILE], unknown.injected);
    expect(unknownResult).toMatchObject({
      code: 3,
      report: {
        rollback: { status: "unverified" },
        perform_after: null,
        action_applied: "none",
      },
    });
    expect(unknown.ctx.setPerformMode).toHaveBeenCalledTimes(2);
  });
});

describe("runShowMode bounded output and first-class route", () => {
  it("redacts credentials, excludes topology/raw config and bounds checks", async () => {
    const statuses = Array.from({ length: 100 }, (_, index) =>
      index === 0 ? ("warn" as const) : ("pass" as const),
    );
    const fixture = deps({ preflight: preflight(statuses) });
    const result = await runShowMode(
      [PROFILE, "--dry-run", "--allow-warn", "--json"],
      fixture.injected,
    );
    const serialized = result.stdout;
    expect(result.code).toBe(0);
    expect(result.report?.preflight.checks).toHaveLength(64);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain("topology");
    expect(serialized).not.toContain("llmBaseUrl");
    expect(serialized).not.toContain("bridgeToken");
    expect(serialized.length).toBeLessThan(30_000);
  });

  const routeServer = setupServer();
  beforeAll(() => routeServer.listen({ onUnhandledRequest: "error" }));
  afterEach(() => routeServer.resetHandlers());
  afterAll(() => routeServer.close());

  it("works with ALLOW_EXEC=0 using authenticated editor context and /api/perform only", async () => {
    const port = 19980;
    const base = `http://127.0.0.1:${port}`;
    let perform = false;
    let execCalls = 0;
    routeServer.use(
      http.get(`${base}/api/editor/context`, ({ request }) => {
        expect(request.headers.get("authorization")).toBe(`Bearer ${SECRET}`);
        return HttpResponse.json({ ok: true, data: editor(perform) });
      }),
      http.post(`${base}/api/perform`, async ({ request }) => {
        expect(request.headers.get("authorization")).toBe(`Bearer ${SECRET}`);
        const body = (await request.json()) as { enabled: boolean };
        perform = body.enabled;
        return HttpResponse.json({ ok: true, data: write(body.enabled) });
      }),
      http.post(`${base}/api/exec`, () => {
        execCalls += 1;
        return new HttpResponse(null, { status: 403 });
      }),
    );
    const client = new TouchDesignerClient({
      baseUrl: base,
      timeoutMs: 500,
      retries: 0,
      token: SECRET,
    });
    const realContext = { client } as unknown as ToolContext;
    const fixture = deps({
      runtime: runtimeReport({ endpoint: base }),
      doctor: doctorReport(undefined, base),
      loadedConfig: { ...config(port), bridgeToken: SECRET, rawPython: "off" },
    });
    fixture.injected.buildToolContext = vi.fn(() => realContext);
    const result = await runShowMode([PROFILE, "--timeout-ms", "500"], fixture.injected);
    expect(result).toMatchObject({ code: 0, report: { action_applied: "entered" } });
    expect(execCalls).toBe(0);
  });
});
