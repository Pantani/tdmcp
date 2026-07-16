import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDoctor } from "../../src/cli/doctor.js";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import type { ToolContext } from "../../src/tools/types.js";
import type { TdmcpConfig } from "../../src/utils/config.js";
import { silentLogger } from "../../src/utils/logger.js";

/**
 * Focused tests for `src/cli/doctor.ts` — exercises each check branch
 * (pass/warn/fail), the --fix repair paths, JSON-ish config rendering,
 * and the critical-config-failure short-circuit.
 *
 * All filesystem, bridge, install-bridge, textport, and LLM hooks are
 * injected to keep the suite offline and deterministic.
 */

const baseConfig = (overrides: Partial<TdmcpConfig> = {}): TdmcpConfig =>
  ({
    tdHost: "127.0.0.1",
    tdPort: 9980,
    transport: "stdio",
    httpPort: 4040,
    httpHost: "127.0.0.1",
    rawPython: "on",
    toolProfile: "full",
    bridgeToken: undefined,
    llmBaseUrl: "http://127.0.0.1:11434/v1",
    llmApiKey: undefined,
    llmModel: "qwen2.5:3b",
    llmTimeoutMs: 60_000,
    chatPort: 4141,
    vaultPath: undefined,
    eventsEnabled: false,
    eventsAllowHighFrequency: false,
    bridgeAllowExec: true,
    ...overrides,
  }) as unknown as TdmcpConfig;

interface FakeClientOpts {
  fail?: boolean;
}
const makeFakeCtx =
  (opts: FakeClientOpts = {}) =>
  (_cfg: TdmcpConfig): ToolContext => ({
    client: {
      endpoint: "http://127.0.0.1:9980",
      getInfo: () =>
        opts.fail
          ? Promise.reject(new Error("bridge offline"))
          : Promise.resolve({
              td_version: "2023.12000",
              python_version: "3.11.1",
              bridge_version: "0.3.0",
            }),
      // biome-ignore lint/suspicious/noExplicitAny: stub client for doctor
    } as any,
    knowledge: new KnowledgeBase(),
    recipes: new RecipeLibrary(),
    logger: silentLogger,
  });

interface LlmHealth {
  ok: boolean;
  modelReady: boolean;
  detail: string;
}
const makeFakeLlm = (health: LlmHealth) => (_cfg: TdmcpConfig) => ({
  health: () => Promise.resolve(health),
});

let tmpRoot: string;
const noProjectRagIndex = { indexSize: () => null };

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "tdmcp-doctor-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("runDoctor", () => {
  it("returns ok with all checks pass when bridge + llm are healthy", async () => {
    const r = await runDoctor({
      config: baseConfig({ bridgeToken: "secret" }),
      makeCtx: makeFakeCtx(),
      makeLlmClient: makeFakeLlm({ ok: true, modelReady: true, detail: "model ready" }),
      vaultProbe: () => ({ exists: false, isDir: false }),
      profileDirPath: tmpRoot,
      projectRagProbes: noProjectRagIndex,
    });
    expect(r.code).toBe(0);
    expect(r.report.ok).toBe(true);
    expect(r.stdout).toContain("All good");
    const bridge = r.report.checks.find((c) => c.id === "bridge");
    expect(bridge?.status).toBe("pass");
    const llm = r.report.checks.find((c) => c.id === "llm");
    expect(llm?.status).toBe("pass");
  });

  it("marks bridge as fail (critical) when getInfo rejects, exits 1", async () => {
    const r = await runDoctor({
      config: baseConfig(),
      makeCtx: makeFakeCtx({ fail: true }),
      makeLlmClient: makeFakeLlm({ ok: false, modelReady: false, detail: "offline" }),
    });
    expect(r.code).toBe(1);
    expect(r.report.ok).toBe(false);
    expect(r.stdout).toContain("Setup is not ready");
    expect(r.stderr).toBe("");
  });

  it("returns critical config failure when loadConfig throws (no config injected)", async () => {
    // Force loadConfig to throw by setting an invalid env var.
    const prev = process.env.TDMCP_TD_PORT;
    process.env.TDMCP_TD_PORT = "not-a-number";
    try {
      const r = await runDoctor({});
      expect(r.code).toBe(1);
      expect(r.report.checks).toHaveLength(1);
      expect(r.report.checks[0]?.id).toBe("config");
      expect(r.report.checks[0]?.status).toBe("fail");
      expect(r.stdout).toContain("invalid configuration");
      expect(r.stderr).toBe("");
    } finally {
      if (prev === undefined) delete process.env.TDMCP_TD_PORT;
      else process.env.TDMCP_TD_PORT = prev;
    }
  });

  it("warns on llm unreachable", async () => {
    const r = await runDoctor({
      config: baseConfig(),
      makeCtx: makeFakeCtx(),
      makeLlmClient: makeFakeLlm({ ok: false, modelReady: false, detail: "ECONNREFUSED" }),
    });
    const llm = r.report.checks.find((c) => c.id === "llm");
    expect(llm?.status).toBe("warn");
    expect(llm?.detail).toContain("not reachable");
  });

  it("warns on llm reachable but model not pulled", async () => {
    const r = await runDoctor({
      config: baseConfig(),
      makeCtx: makeFakeCtx(),
      makeLlmClient: makeFakeLlm({ ok: true, modelReady: false, detail: "model missing" }),
    });
    const llm = r.report.checks.find((c) => c.id === "llm");
    expect(llm?.status).toBe("warn");
    expect(llm?.detail).toContain("ollama pull");
  });

  it("warns on vault path set but missing", async () => {
    const r = await runDoctor({
      config: baseConfig({ vaultPath: "/nonexistent/vault" }),
      makeCtx: makeFakeCtx(),
      makeLlmClient: makeFakeLlm({ ok: true, modelReady: true, detail: "ok" }),
      vaultProbe: () => ({ exists: false, isDir: false }),
    });
    const vault = r.report.checks.find((c) => c.id === "vault");
    expect(vault?.status).toBe("warn");
    expect(vault?.detail).toContain("does not exist");
  });

  it("warns on vault path that exists but is not a directory", async () => {
    const r = await runDoctor({
      config: baseConfig({ vaultPath: "/some/file" }),
      makeCtx: makeFakeCtx(),
      makeLlmClient: makeFakeLlm({ ok: true, modelReady: true, detail: "ok" }),
      vaultProbe: () => ({ exists: true, isDir: false }),
    });
    const vault = r.report.checks.find((c) => c.id === "vault");
    expect(vault?.status).toBe("warn");
    expect(vault?.detail).toContain("not a folder");
  });

  it("expands ~/ in vault path before probing", async () => {
    let probed = "";
    await runDoctor({
      config: baseConfig({ vaultPath: "~/notes" }),
      makeCtx: makeFakeCtx(),
      makeLlmClient: makeFakeLlm({ ok: true, modelReady: true, detail: "ok" }),
      vaultProbe: (p) => {
        probed = p;
        return { exists: true, isDir: true };
      },
    });
    expect(probed).not.toContain("~");
    expect(probed).toMatch(/notes$/);
  });

  it("reports restricted tools when rawPython=off / toolProfile=safe", async () => {
    const r = await runDoctor({
      config: baseConfig({ rawPython: "off", toolProfile: "safe" }),
      makeCtx: makeFakeCtx(),
      makeLlmClient: makeFakeLlm({ ok: true, modelReady: true, detail: "ok" }),
    });
    const tools = r.report.checks.find((c) => c.id === "tools");
    expect(tools?.detail).toContain("restricted");
    expect(tools?.detail).toContain("raw-Python");
    expect(tools?.detail).toContain("destructive");
  });

  it("reports bridge_token=pass when set", async () => {
    const r = await runDoctor({
      config: baseConfig({ bridgeToken: "secret" }),
      makeCtx: makeFakeCtx(),
      makeLlmClient: makeFakeLlm({ ok: true, modelReady: true, detail: "ok" }),
    });
    const tok = r.report.checks.find((c) => c.id === "bridge_token");
    expect(tok?.status).toBe("pass");
  });

  it("reports profile_dir=pass when directory exists", async () => {
    const r = await runDoctor({
      config: baseConfig(),
      makeCtx: makeFakeCtx(),
      makeLlmClient: makeFakeLlm({ ok: true, modelReady: true, detail: "ok" }),
      profileDirPath: tmpRoot, // a real dir
    });
    const p = r.report.checks.find((c) => c.id === "profile_dir");
    expect(p?.status).toBe("pass");
  });

  it("reports profile_dir=warn when path exists but is a file", async () => {
    const filePath = join(tmpRoot, "not-a-dir");
    writeFileSync(filePath, "x");
    const r = await runDoctor({
      config: baseConfig(),
      makeCtx: makeFakeCtx(),
      makeLlmClient: makeFakeLlm({ ok: true, modelReady: true, detail: "ok" }),
      profileDirPath: filePath,
    });
    const p = r.report.checks.find((c) => c.id === "profile_dir");
    expect(p?.status).toBe("warn");
    expect(p?.detail).toContain("not a directory");
  });

  it("--fix repairs missing vault folder via injected vaultRepair", async () => {
    const vaultPath = join(tmpRoot, "vault");
    let repaired = "";
    let probeCalls = 0;
    const r = await runDoctor({
      fix: true,
      config: baseConfig({ vaultPath }),
      makeCtx: makeFakeCtx(),
      makeLlmClient: makeFakeLlm({ ok: true, modelReady: true, detail: "ok" }),
      vaultProbe: () => {
        probeCalls += 1;
        // First call: missing (triggers repair). Second call (after repair): exists.
        return probeCalls === 1 ? { exists: false, isDir: false } : { exists: true, isDir: true };
      },
      vaultRepair: (p) => {
        repaired = p;
      },
    });
    expect(repaired).toContain("vault");
    const applied = r.report.repairs?.find((x) => x.id === "vault");
    expect(applied?.status).toBe("applied");
  });

  it("--fix records a failed vault repair when vaultRepair throws", async () => {
    const r = await runDoctor({
      fix: true,
      config: baseConfig({ vaultPath: join(tmpRoot, "v") }),
      makeCtx: makeFakeCtx(),
      makeLlmClient: makeFakeLlm({ ok: true, modelReady: true, detail: "ok" }),
      vaultProbe: () => ({ exists: false, isDir: false }),
      vaultRepair: () => {
        throw new Error("permission denied");
      },
    });
    const failed = r.report.repairs?.find((x) => x.id === "vault");
    expect(failed?.status).toBe("failed");
    expect(failed?.detail).toContain("permission denied");
  });

  it("--fix writes bridge token via injected envFileWrite when token missing", async () => {
    const envPath = join(tmpRoot, ".env");
    let writtenTo = "";
    let writtenToken = "";
    const r = await runDoctor({
      fix: true,
      config: baseConfig(), // no bridgeToken
      makeCtx: makeFakeCtx(),
      makeLlmClient: makeFakeLlm({ ok: true, modelReady: true, detail: "ok" }),
      envFilePath: envPath,
      envFileWrite: (p, tok) => {
        writtenTo = p;
        writtenToken = tok;
      },
      profileDirPath: tmpRoot,
    });
    expect(writtenTo).toBe(envPath);
    expect(writtenToken).toMatch(/^[0-9a-f]{48}$/);
    const repair = r.report.repairs?.find((x) => x.id === "bridge_token");
    expect(repair?.status).toBe("applied");
  });

  it("--fix repairs missing profile dir via injected profileDirRepair", async () => {
    const profilePath = join(tmpRoot, "profiles-missing");
    let created = "";
    const r = await runDoctor({
      fix: true,
      config: baseConfig({ bridgeToken: "x" }),
      makeCtx: makeFakeCtx(),
      makeLlmClient: makeFakeLlm({ ok: true, modelReady: true, detail: "ok" }),
      profileDirPath: profilePath,
      profileDirRepair: (p) => {
        created = p;
      },
    });
    expect(created).toBe(profilePath);
    const repair = r.report.repairs?.find((x) => x.id === "profile_dir");
    expect(repair?.status).toBe("applied");
  });

  it("--fix can use default filesystem repairs for vault, env token, and profiles", async () => {
    const vaultPath = join(tmpRoot, "vault-default");
    const envPath = join(tmpRoot, ".env");
    const profilePath = join(tmpRoot, "profiles-default");
    writeFileSync(envPath, "EXISTING=1\n", "utf8");

    const r = await runDoctor({
      fix: true,
      config: baseConfig({ vaultPath }),
      makeCtx: makeFakeCtx(),
      makeLlmClient: makeFakeLlm({ ok: true, modelReady: true, detail: "ok" }),
      envFilePath: envPath,
      profileDirPath: profilePath,
      projectRagProbes: noProjectRagIndex,
    });

    expect(existsSync(vaultPath)).toBe(true);
    expect(existsSync(profilePath)).toBe(true);
    expect(readFileSync(envPath, "utf8")).toMatch(
      /EXISTING=1\n\nTDMCP_BRIDGE_TOKEN=[0-9a-f]{48}\n/,
    );
    expect(r.report.repairs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "vault", status: "applied" }),
        expect.objectContaining({ id: "bridge_token", status: "applied" }),
        expect.objectContaining({ id: "profile_dir", status: "applied" }),
      ]),
    );
  });

  it("--fix profile dir reports failed when repair throws", async () => {
    const r = await runDoctor({
      fix: true,
      config: baseConfig({ bridgeToken: "x" }),
      makeCtx: makeFakeCtx(),
      makeLlmClient: makeFakeLlm({ ok: true, modelReady: true, detail: "ok" }),
      profileDirPath: join(tmpRoot, "boom"),
      profileDirRepair: () => {
        throw new Error("disk full");
      },
    });
    const repair = r.report.repairs?.find((x) => x.id === "profile_dir");
    expect(repair?.status).toBe("failed");
    expect(repair?.detail).toContain("disk full");
  });

  it("--fix attempts install-bridge when bridge is down and reports success", async () => {
    const r = await runDoctor({
      fix: true,
      config: baseConfig({ bridgeToken: "x" }),
      makeCtx: makeFakeCtx({ fail: true }),
      makeLlmClient: makeFakeLlm({ ok: true, modelReady: true, detail: "ok" }),
      profileDirPath: tmpRoot,
      runInstallBridge: () =>
        // biome-ignore lint/suspicious/noExplicitAny: install-bridge result shape
        Promise.resolve({ ok: true, detail: "installed" } as any),
    });
    const repair = r.report.repairs?.find((x) => x.id === "bridge");
    expect(repair?.status).toBe("applied");
    expect(repair?.detail).toContain("install-bridge --verify succeeded");
  });

  it("--fix bridge repair stages Textport commands without applying them", async () => {
    const r = await runDoctor({
      fix: true,
      config: baseConfig({ bridgeToken: "x" }),
      makeCtx: makeFakeCtx({ fail: true }),
      makeLlmClient: makeFakeLlm({ ok: true, modelReady: true, detail: "ok" }),
      profileDirPath: tmpRoot,
      runInstallBridge: () =>
        Promise.resolve({
          ok: false,
          detail: "needs textport",
          textportCommand: "td.something()",
          // biome-ignore lint/suspicious/noExplicitAny: install-bridge result shape
        } as any),
    });
    const repair = r.report.repairs?.find((x) => x.id === "bridge");
    expect(repair?.status).toBe("failed");
    expect(repair?.detail).toContain("not applied automatically");
  });

  it("--fix bridge repair reports error when install-bridge throws", async () => {
    const r = await runDoctor({
      fix: true,
      config: baseConfig({ bridgeToken: "x" }),
      makeCtx: makeFakeCtx({ fail: true }),
      makeLlmClient: makeFakeLlm({ ok: true, modelReady: true, detail: "ok" }),
      profileDirPath: tmpRoot,
      runInstallBridge: () => Promise.reject(new Error("spawn ENOENT")),
    });
    const repair = r.report.repairs?.find((x) => x.id === "bridge");
    expect(repair?.status).toBe("failed");
    expect(repair?.detail).toContain("ENOENT");
  });

  it("--fix emits suggested fixes for remaining non-pass checks", async () => {
    const r = await runDoctor({
      fix: true,
      config: baseConfig({ vaultPath: "/nope" }),
      makeCtx: makeFakeCtx({ fail: true }),
      makeLlmClient: makeFakeLlm({ ok: false, modelReady: false, detail: "down" }),
      vaultProbe: () => ({ exists: false, isDir: false }),
      vaultRepair: () => {
        throw new Error("nope");
      },
      runInstallBridge: () =>
        // biome-ignore lint/suspicious/noExplicitAny: install-bridge result shape
        Promise.resolve({ ok: false, detail: "no td running" } as any),
      profileDirPath: tmpRoot,
    });
    expect(r.report.fixes?.length).toBeGreaterThan(0);
    const ids = (r.report.fixes ?? []).map((f) => f.id);
    expect(ids).toContain("bridge");
    expect(ids).toContain("llm");
    expect(r.stdout).toContain("Suggested fixes");
  });

  it("config block reflects resolved settings (tdBaseUrl, llm, chatPort, vault)", async () => {
    const r = await runDoctor({
      config: baseConfig({ vaultPath: "/x", chatPort: 4242 }),
      makeCtx: makeFakeCtx(),
      makeLlmClient: makeFakeLlm({ ok: true, modelReady: true, detail: "ok" }),
      vaultProbe: () => ({ exists: true, isDir: true }),
    });
    expect(r.report.config.tdBaseUrl).toBe("http://127.0.0.1:9980");
    expect(r.report.config.chatPort).toBe(4242);
    expect(r.report.config.vaultPath).toBe("/x");
  });
});
