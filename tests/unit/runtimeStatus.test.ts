import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  probeConfiguredBridge,
  type RuntimeClientAdapterObservation,
  type RuntimeEffectiveConfig,
  RuntimeInteractionSummarySchema,
  type RuntimeStatusDeps,
  RuntimeStatusReportSchema,
  runRuntimeStatus,
} from "../../src/cli/runtimeStatus.js";
import {
  CURATED_SKILL_NAMES,
  type ManageAgentSkillsResult,
  type SkillState,
} from "../../src/skills/types.js";

const TD_BASE = "http://127.0.0.1:9980";
const EXPECTED_BRIDGE_VERSION = "0.13.1";
const SECRET = "status-canary-secret";

const ok = (data: unknown) => HttpResponse.json({ ok: true, data });

function healthData() {
  return {
    state: "healthy",
    status: "ok",
    heartbeat: { stale: false },
    degraded_signals: [],
    warnings: [],
    touchdesigner: {
      td_version: "2025.32820",
      build: "2025.32820",
      bridge_version: EXPECTED_BRIDGE_VERSION,
      project: `/projects/${SECRET}/show.toe`,
    },
  };
}

function editorData(performMode = false, uiAvailable = true) {
  return {
    project: {
      name: SECRET,
      folder: `/projects/${SECRET}`,
      save_version: null,
      save_build: "2025.32820",
    },
    touchdesigner: { build: "2025.32820", version: "2025.32820" },
    perform_mode: performMode,
    ui_available: uiAvailable,
    panes: [],
    active_network_editor: uiAvailable
      ? {
          pane: {},
          owner: `/project1/${SECRET}`,
          current: `/project1/${SECRET}/current`,
          selected: [`/project1/${SECRET}/selected`],
          rollover_operator: `/project1/${SECRET}/rollover`,
          rollover_parameter: { name: SECRET, owner: `/project1/${SECRET}` },
          viewport: { x: 10, y: 20, zoom: 1 },
        }
      : null,
    warnings: [`private ${SECRET}`],
  };
}

const defaultHandlers = [
  http.get(`${TD_BASE}/api/health`, () => ok(healthData())),
  http.get(`${TD_BASE}/api/editor/context`, () => ok(editorData())),
  http.get(`${TD_BASE}/api/interactions/status`, () =>
    ok({ pending_count: 0, pending_limit: 3, active: false, delivery_configured: true }),
  ),
  http.get(`${TD_BASE}/api/info`, () =>
    ok({
      td_version: "2025.32820",
      build: "2025.32820",
      bridge_version: EXPECTED_BRIDGE_VERSION,
      project: `/projects/${SECRET}/fallback.toe`,
    }),
  ),
];

const server = setupServer(...defaultHandlers);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});
afterAll(() => server.close());

function effectiveConfig(overrides: Partial<RuntimeEffectiveConfig> = {}): RuntimeEffectiveConfig {
  return {
    profile: "local",
    source_kind: "workspace",
    transport: "stdio",
    bridge_endpoint: TD_BASE,
    mcp_endpoint: null,
    http_auth_mode: "static",
    request_timeout_ms: 10_000,
    bridge_token: SECRET,
    mcp_http_token_configured: true,
    tool_profile: "safe",
    raw_python: "off",
    yolo: false,
    ...overrides,
  };
}

function skillResult(state: SkillState = "installed"): ManageAgentSkillsResult {
  return {
    action: "status",
    status: "no_change",
    dry_run: true,
    host: "codex",
    scope: "user",
    target_root: `/home/${SECRET}/.codex/skills`,
    manifest_path: `/home/${SECRET}/.codex/skills/.tdmcp-skills.json`,
    source_version: "1",
    planned: [],
    applied: [],
    skills: CURATED_SKILL_NAMES.map((name) => ({
      name,
      path: `/home/${SECRET}/${name}`,
      state,
      source_sha256: "a".repeat(64),
      ...(state === "not_installed" || state === "missing"
        ? {}
        : { installed_sha256: "a".repeat(64) }),
      owned: true,
    })),
    warnings: [`private ${SECRET}`],
  };
}

function clientObservations(): RuntimeClientAdapterObservation[] {
  return [
    {
      client: "codex",
      scope: "user",
      registration: "registered",
      command_matches: true,
      endpoint_matches: true,
      token_presence: "configured",
    },
    {
      client: "claude",
      scope: "project",
      registration: "not_registered",
      command_matches: null,
      endpoint_matches: null,
      token_presence: "absent",
    },
    {
      client: "claude",
      scope: "user",
      registration: "not_registered",
      command_matches: null,
      endpoint_matches: null,
      token_presence: "absent",
    },
    {
      client: "cursor",
      scope: "project",
      registration: "not_registered",
      command_matches: null,
      endpoint_matches: null,
      token_presence: "absent",
    },
    {
      client: "cursor",
      scope: "user",
      registration: "not_registered",
      command_matches: null,
      endpoint_matches: null,
      token_presence: "absent",
    },
  ];
}

function makeDeps(overrides: Partial<RuntimeStatusDeps> = {}): RuntimeStatusDeps {
  return {
    readConfig: async () => ({ state: "available", config: effectiveConfig() }),
    readSkills: async () => [skillResult()],
    readClients: async () => clientObservations(),
    expectedBridgeVersion: EXPECTED_BRIDGE_VERSION,
    now: () => new Date("2026-07-14T12:00:00.000Z"),
    ...overrides,
  };
}

describe("runtime status CLI builder", () => {
  it("uses health as the sole core probe and emits a stable redacted report", async () => {
    const infoCalls = vi.fn();
    server.use(
      http.get(`${TD_BASE}/api/info`, () => {
        infoCalls();
        return ok({});
      }),
    );
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) =>
      fetch(input, init),
    );
    const fetchSpy = fetchMock as typeof fetch;

    const result = await runRuntimeStatus(
      ["--json"],
      makeDeps({
        fetchImpl: fetchSpy,
        readConfig: async () => ({
          state: "available",
          config: effectiveConfig({
            bridge_endpoint: `http://user:${SECRET}@127.0.0.1:9980/private?token=${SECRET}`,
          }),
        }),
      }),
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(infoCalls).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const call of fetchMock.mock.calls) {
      expect(call[1]?.method).toBe("GET");
      expect(String(call[0])).not.toContain("/api/exec");
    }
    expect(result.stdout).not.toContain(SECRET);
    const report = RuntimeStatusReportSchema.parse(JSON.parse(result.stdout));
    expect(report.readiness).toBe("ready");
    expect(report.config.bridge_endpoint).toBe(TD_BASE);
    expect(report.config.bridge_token).toBe("configured");
    expect(report.bridge.version_state).toBe("match");
    expect(report.touchdesigner.project).toEqual({ state: "available", present: true });
    expect(report.policy.bridge_allow_exec).toBe("unknown");
    expect(report.interactions.fail_closed_choice).toBe("Keep");
  });

  it("falls back to info only when health returns HTTP 404", async () => {
    const infoCalls = vi.fn();
    server.use(
      http.get(`${TD_BASE}/api/health`, () => HttpResponse.json({}, { status: 404 })),
      http.get(`${TD_BASE}/api/info`, () => {
        infoCalls();
        return ok({
          td_version: "2024.10000",
          build: "2024.10000",
          bridge_version: "0.12.0",
        });
      }),
    );

    const result = await runRuntimeStatus(["--json"], makeDeps());

    expect(result.code).toBe(0);
    expect(infoCalls).toHaveBeenCalledOnce();
    expect(result.report?.bridge.health).toBe("unknown");
    expect(result.report?.bridge.version_state).toBe("stale");
    expect(result.report?.readiness).toBe("degraded");
    expect(result.report?.warnings).toContainEqual({
      code: "bridge_version_mismatch",
      message: "The running bridge version differs from this tdmcp build.",
    });
  });

  it("does not use info fallback for a reached bridge rejection", async () => {
    const infoCalls = vi.fn();
    server.use(
      http.get(`${TD_BASE}/api/health`, () => HttpResponse.json({}, { status: 403 })),
      http.get(`${TD_BASE}/api/info`, () => {
        infoCalls();
        return ok({});
      }),
    );

    const result = await runRuntimeStatus(["--json"], makeDeps());

    expect(result.code).toBe(4);
    expect(infoCalls).not.toHaveBeenCalled();
    expect(result.report?.bridge).toMatchObject({
      state: "unavailable",
      reason_code: "bridge_rejected",
    });
  });

  it("reports the configured bridge offline as data with exit code 3", async () => {
    server.use(
      http.get(`${TD_BASE}/api/health`, () => HttpResponse.error()),
      http.get(`${TD_BASE}/api/editor/context`, () => HttpResponse.error()),
      http.get(`${TD_BASE}/api/interactions/status`, () => HttpResponse.error()),
    );

    const result = await runRuntimeStatus(["--json"], makeDeps());

    expect(result.code).toBe(3);
    expect(result.stderr).toBe("");
    expect(result.report?.readiness).toBe("not_ready");
    expect(result.report?.bridge).toMatchObject({
      state: "unavailable",
      reason_code: "bridge_offline",
    });
    expect(result.report?.touchdesigner.state).toBe("unknown");
    expect(JSON.parse(result.stdout)).toBeTruthy();
  });

  it("bounds all concurrent bridge reads by one timeout window", async () => {
    const neverFetch = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener(
            "abort",
            () => {
              const error = new Error("private body timeout detail");
              error.name = "AbortError";
              controller.error(error);
            },
            { once: true },
          );
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    }) as typeof fetch;
    const startedAt = Date.now();

    const result = await runRuntimeStatus(
      ["--json", "--timeout-ms", "100"],
      makeDeps({ fetchImpl: neverFetch }),
    );

    expect(Date.now() - startedAt).toBeLessThan(700);
    expect(result.code).toBe(3);
    expect(result.report?.bridge.reason_code).toBe("bridge_timeout");
    expect(neverFetch).toHaveBeenCalledTimes(3);
  });

  it("rejects oversized response bodies before trusting their content", async () => {
    const oversizedFetch = vi.fn(() =>
      Promise.resolve(
        new Response("{}", {
          status: 200,
          headers: { "content-length": String(256 * 1024 + 1) },
        }),
      ),
    ) as typeof fetch;

    const result = await runRuntimeStatus(["--json"], makeDeps({ fetchImpl: oversizedFetch }));

    expect(result.code).toBe(4);
    expect(result.report?.bridge.reason_code).toBe("malformed_response");
    expect(oversizedFetch).toHaveBeenCalledTimes(3);
  });

  it("keeps optional editor and interaction failures non-fatal and honest", async () => {
    server.use(
      http.get(`${TD_BASE}/api/editor/context`, () => HttpResponse.json({}, { status: 404 })),
      http.get(`${TD_BASE}/api/interactions/status`, () => HttpResponse.json({}, { status: 404 })),
    );

    const result = await runRuntimeStatus(["--json"], makeDeps());

    expect(result.code).toBe(0);
    expect(result.report?.readiness).toBe("degraded");
    expect(result.report?.touchdesigner.ui.state).toBe("unknown");
    expect(result.report?.interactions).toMatchObject({
      state: "unavailable",
      reason_code: "endpoint_unsupported",
      pending_count: null,
    });
  });

  it("reports native interaction unavailable in perform mode", async () => {
    server.use(http.get(`${TD_BASE}/api/editor/context`, () => ok(editorData(true, false))));

    const result = await runRuntimeStatus(["--json"], makeDeps());

    expect(result.code).toBe(0);
    expect(result.report?.touchdesigner.perform_mode).toBe(true);
    expect(result.report?.interactions).toMatchObject({
      state: "unavailable",
      native_ui: "unavailable",
      reason_code: "perform_mode",
    });
  });

  it("renders bounded remediation for unavailable human-status rows", async () => {
    const result = await runRuntimeStatus(
      [],
      makeDeps({
        readConfig: async () => ({
          state: "unavailable",
          reason_code: "config_missing_explicit",
          profile: "missing",
        }),
      }),
    );

    expect(result.code).toBe(2);
    expect(result.stdout).toContain("Next safe checks:");
    expect(result.stdout).toContain("tdmcp init --dry-run");
    expect(result.stdout).toContain("tdmcp install-bridge --verify");
    expect(result.stdout).toContain("tdmcp install-client <claude|codex|cursor> --check");
    expect(result.report).toBeDefined();
  });

  it("maps frozen owned-skill DTOs without emitting owned paths or warnings", async () => {
    const result = await runRuntimeStatus(
      ["--json"],
      makeDeps({ readSkills: async () => [skillResult("drifted")] }),
    );

    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain(SECRET);
    expect(result.report?.skills).toMatchObject({
      state: "unavailable",
      reason_code: "manifest_invalid",
      installed_count: CURATED_SKILL_NAMES.length,
    });
    expect(result.report?.skills.installations[0]).toMatchObject({
      host: "codex",
      scope: "user",
      manifest_version: null,
      integrity: "invalid",
      hash_mismatch_count: CURATED_SKILL_NAMES.length,
    });
    expect(result.report?.skills.source_version).toBe("1");
  });

  it("does not count manifest hashes as installed content for missing skills", async () => {
    const missing = skillResult("missing");
    missing.skills = missing.skills.map((skill) => ({
      ...skill,
      installed_sha256: "b".repeat(64),
    }));

    const result = await runRuntimeStatus(
      ["--json"],
      makeDeps({ readSkills: async () => [missing] }),
    );

    expect(result.report?.skills.installed_count).toBe(0);
    expect(result.report?.skills.installations[0]).toMatchObject({
      integrity: "missing",
      installed_count: 0,
    });
  });

  it("sanitizes client reader failures and fills all known observations", async () => {
    const result = await runRuntimeStatus(
      ["--json"],
      makeDeps({
        readClients: async () => {
          throw new Error(`client path /home/${SECRET}/config.toml`);
        },
      }),
    );

    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain(SECRET);
    expect(result.report?.clients.state).toBe("unknown");
    expect(
      result.report?.clients.observations.map((item) => `${item.client}:${item.scope}`),
    ).toEqual(["claude:project", "claude:user", "cursor:project", "cursor:user", "codex:user"]);
  });

  it("returns config failures without probing a guessed endpoint", async () => {
    const fetchSpy = vi.fn();
    const result = await runRuntimeStatus(
      ["--json", "--profile", "missing"],
      makeDeps({
        fetchImpl: fetchSpy as unknown as typeof fetch,
        readConfig: async () => ({
          state: "unavailable",
          reason_code: "profile_missing",
          profile: "missing",
        }),
      }),
    );

    expect(result.code).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.report?.config).toMatchObject({
      state: "unavailable",
      reason_code: "profile_missing",
    });
    expect(result.report?.bridge.reason_code).toBe("config_unavailable");
  });

  it("handles help and invalid flags without calling any adapter", async () => {
    const readConfig = vi.fn(async () => ({
      state: "available" as const,
      config: effectiveConfig(),
    }));
    const deps = makeDeps({ readConfig });

    const help = await runRuntimeStatus(["--help"], deps);
    const invalid = await runRuntimeStatus(["--all-instances"], deps);

    expect(help).toMatchObject({ code: 0, stderr: "" });
    expect(help.stdout).toContain("Usage: tdmcp status");
    expect(invalid).toMatchObject({ code: 2, stdout: "" });
    expect(invalid.stderr).toBe("Invalid status arguments. Run `tdmcp status --help`.\n");
    expect(readConfig).not.toHaveBeenCalled();
  });

  it("rejects overlong profile and config values instead of truncating them", async () => {
    const readConfig = vi.fn(async () => ({
      state: "available" as const,
      config: effectiveConfig(),
    }));
    const deps = makeDeps({ readConfig });

    const profile = await runRuntimeStatus(["--profile", "p".repeat(129)], deps);
    const config = await runRuntimeStatus(["--config", `/${"c".repeat(4096)}`], deps);

    expect(profile.code).toBe(2);
    expect(config.code).toBe(2);
    expect(readConfig).not.toHaveBeenCalled();
  });

  it("rejects interaction summaries with extra content-bearing fields", () => {
    expect(
      RuntimeInteractionSummarySchema.safeParse({
        pending_count: 1,
        pending_limit: 3,
        active: true,
        delivery_configured: true,
        prompt: SECRET,
      }).success,
    ).toBe(false);
  });

  it("keeps the bridge probe independently injectable for the integrator", async () => {
    const probe = await probeConfiguredBridge({
      endpoint: TD_BASE,
      timeout_ms: 1500,
      expected_bridge_version: EXPECTED_BRIDGE_VERSION,
    });

    expect(probe.code).toBe(0);
    expect(probe.bridge.state).toBe("available");
    expect(probe.interactions.pending_count).toBe(0);
  });
});
