import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { runDoctor } from "../../src/cli/doctor.js";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import type { ToolContext } from "../../src/tools/types.js";
import { loadConfig, type TdmcpConfig } from "../../src/utils/config.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, offlineInfoHandler, TD_BASE } from "../helpers/tdMock.js";

const server = makeTdServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const LLM_BASE = "http://127.0.0.1:11434/v1";

function makeConfig(overrides: Partial<TdmcpConfig> = {}): TdmcpConfig {
  return { ...loadConfig({}), llmBaseUrl: LLM_BASE, ...overrides };
}

function makeCtx(): ToolContext {
  return {
    client: new TouchDesignerClient({ baseUrl: TD_BASE, timeoutMs: 2000 }),
    knowledge: new KnowledgeBase(),
    recipes: new RecipeLibrary(),
    logger: silentLogger,
  };
}

function llmModels(...ids: string[]) {
  return http.get(`${LLM_BASE}/models`, () =>
    HttpResponse.json({ data: ids.map((id) => ({ id })) }),
  );
}

describe("doctor --fix: bridge_token repair", () => {
  it("warns when TDMCP_BRIDGE_TOKEN is not set", async () => {
    server.use(llmModels("qwen2.5:3b"));
    const r = await runDoctor({
      config: makeConfig({ bridgeToken: undefined }),
      makeCtx,
    });
    const check = r.report.checks.find((c) => c.id === "bridge_token");
    expect(check?.status).toBe("warn");
    expect(check?.critical).toBe(false);
  });

  it("passes when TDMCP_BRIDGE_TOKEN is set", async () => {
    server.use(llmModels("qwen2.5:3b"));
    const r = await runDoctor({
      config: makeConfig({ bridgeToken: "secret-token" }),
      makeCtx,
    });
    const check = r.report.checks.find((c) => c.id === "bridge_token");
    expect(check?.status).toBe("pass");
  });

  it("--fix generates and writes a token to .env when not set", async () => {
    server.use(llmModels("qwen2.5:3b"));
    const dir = mkdtempSync(join(tmpdir(), "tdmcp-doctor-token-"));
    const envFile = join(dir, ".env");
    const written: Array<{ filePath: string; token: string }> = [];
    try {
      const r = await runDoctor({
        config: makeConfig({ bridgeToken: undefined }),
        makeCtx,
        fix: true,
        envFilePath: envFile,
        envFileWrite: (filePath, token) => {
          written.push({ filePath, token });
          writeFileSync(filePath, `TDMCP_BRIDGE_TOKEN=${token}\n`);
        },
      });
      expect(written).toHaveLength(1);
      expect(written[0]?.token).toMatch(/^[0-9a-f]{48}$/);
      expect(r.report.repairs).toContainEqual(
        expect.objectContaining({ id: "bridge_token", status: "applied" }),
      );
      expect(r.stdout).toContain("Applied fixes");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--fix does not write a token when bridge_token is already set (pass)", async () => {
    server.use(llmModels("qwen2.5:3b"));
    const written: string[] = [];
    const r = await runDoctor({
      config: makeConfig({ bridgeToken: "already-set" }),
      makeCtx,
      fix: true,
      envFileWrite: (_, token) => {
        written.push(token);
      },
    });
    expect(written).toHaveLength(0);
    expect(r.report.repairs?.find((rep) => rep.id === "bridge_token")).toBeUndefined();
  });

  it("--fix reports a failed token write and preserves fix suggestion", async () => {
    server.use(llmModels("qwen2.5:3b"));
    const r = await runDoctor({
      config: makeConfig({ bridgeToken: undefined }),
      makeCtx,
      fix: true,
      envFileWrite: () => {
        throw new Error("disk full");
      },
    });
    expect(r.report.repairs).toContainEqual(
      expect.objectContaining({ id: "bridge_token", status: "failed" }),
    );
    const detail = r.report.repairs?.find((rep) => rep.id === "bridge_token")?.detail ?? "";
    expect(detail).toContain("disk full");
    // fix suggestion still present
    expect(r.report.fixes?.some((f) => f.id === "bridge_token")).toBe(true);
  });

  it("does not write a token without --fix", async () => {
    server.use(llmModels("qwen2.5:3b"));
    const written: string[] = [];
    const r = await runDoctor({
      config: makeConfig({ bridgeToken: undefined }),
      makeCtx,
      envFileWrite: (_, token) => {
        written.push(token);
      },
    });
    expect(written).toHaveLength(0);
    expect(r.report.repairs).toBeUndefined();
  });

  it("default envFileWrite appends to an existing .env without duplicate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tdmcp-env-append-"));
    const envFile = join(dir, ".env");
    writeFileSync(envFile, "OTHER_VAR=foo\n");
    // Use the real defaultEnvFileWrite by not injecting envFileWrite, but point at our tmpdir file
    server.use(llmModels("qwen2.5:3b"));
    await runDoctor({
      config: makeConfig({ bridgeToken: undefined }),
      makeCtx,
      fix: true,
      envFilePath: envFile,
    });
    const content = readFileSync(envFile, "utf8");
    expect(content).toContain("TDMCP_BRIDGE_TOKEN=");
    // should appear exactly once
    expect(content.split("TDMCP_BRIDGE_TOKEN=").length).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("doctor --fix: bridge repair", () => {
  it("warns when bridge is unreachable", async () => {
    server.use(offlineInfoHandler);
    server.use(llmModels("qwen2.5:3b"));
    const r = await runDoctor({ config: makeConfig(), makeCtx });
    const check = r.report.checks.find((c) => c.id === "bridge");
    expect(check?.status).toBe("fail");
  });

  it("--fix with runInstallBridge runs it and reports applied on success", async () => {
    server.use(offlineInfoHandler, llmModels("qwen2.5:3b"));
    const r = await runDoctor({
      config: makeConfig(),
      makeCtx,
      fix: true,
      runInstallBridge: async () => ({ ok: true, detail: "bridge installed" }),
    });
    expect(r.report.repairs).toContainEqual(
      expect.objectContaining({ id: "bridge", status: "applied" }),
    );
    expect(r.stdout).toContain("Applied fixes");
  });

  it("--fix with runInstallBridge reports failed on failure", async () => {
    server.use(offlineInfoHandler, llmModels("qwen2.5:3b"));
    const r = await runDoctor({
      config: makeConfig(),
      makeCtx,
      fix: true,
      runInstallBridge: async () => ({ ok: false, detail: "TD not running" }),
    });
    expect(r.report.repairs).toContainEqual(
      expect.objectContaining({ id: "bridge", status: "failed" }),
    );
    expect(r.stdout).toContain("Failed fixes");
  });

  it("--fix without runInstallBridge falls back to the default spawn runner", async () => {
    server.use(offlineInfoHandler, llmModels("qwen2.5:3b"));
    // Point TDMCP_BIN at a binary that always fails, so the default spawn
    // exercises but reports a failed repair instead of trying real `tdmcp`.
    const prev = process.env.TDMCP_BIN;
    process.env.TDMCP_BIN = "false";
    try {
      const r = await runDoctor({
        config: makeConfig(),
        makeCtx,
        fix: true,
      });
      // The default runner spawned and the bridge repair was attempted (not silently skipped).
      expect(r.report.repairs).toContainEqual(
        expect.objectContaining({ id: "bridge", status: "failed" }),
      );
    } finally {
      if (prev === undefined) delete process.env.TDMCP_BIN;
      else process.env.TDMCP_BIN = prev;
    }
  });

  it("--fix handles a thrown error from runInstallBridge gracefully", async () => {
    server.use(offlineInfoHandler, llmModels("qwen2.5:3b"));
    const r = await runDoctor({
      config: makeConfig(),
      makeCtx,
      fix: true,
      runInstallBridge: async () => {
        throw new Error("spawn error");
      },
    });
    expect(r.report.repairs).toContainEqual(
      expect.objectContaining({ id: "bridge", status: "failed" }),
    );
  });
});

describe("doctor --fix: profile_dir repair", () => {
  it("warns when profile directory is missing", async () => {
    server.use(llmModels("qwen2.5:3b"));
    const r = await runDoctor({
      config: makeConfig(),
      makeCtx,
      profileDirPath: join(tmpdir(), `tdmcp-nonexistent-profile-dir-${Date.now()}`),
    });
    const check = r.report.checks.find((c) => c.id === "profile_dir");
    expect(check?.status).toBe("warn");
    expect(check?.critical).toBe(false);
  });

  it("passes when profile directory exists", async () => {
    server.use(llmModels("qwen2.5:3b"));
    const dir = mkdtempSync(join(tmpdir(), "tdmcp-profiles-"));
    try {
      const r = await runDoctor({
        config: makeConfig(),
        makeCtx,
        profileDirPath: dir,
      });
      const check = r.report.checks.find((c) => c.id === "profile_dir");
      expect(check?.status).toBe("pass");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--fix creates the profile directory and reports applied", async () => {
    server.use(llmModels("qwen2.5:3b"));
    const base = mkdtempSync(join(tmpdir(), "tdmcp-prof-fix-"));
    const profileDir = join(base, "profiles");
    try {
      const r = await runDoctor({
        config: makeConfig(),
        makeCtx,
        fix: true,
        profileDirPath: profileDir,
      });
      expect(existsSync(profileDir)).toBe(true);
      expect(r.report.repairs).toContainEqual(
        expect.objectContaining({ id: "profile_dir", status: "applied" }),
      );
      expect(r.report.checks.find((c) => c.id === "profile_dir")?.status).toBe("pass");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("--fix reports failed profile dir repair and preserves fix suggestion", async () => {
    server.use(llmModels("qwen2.5:3b"));
    const r = await runDoctor({
      config: makeConfig(),
      makeCtx,
      fix: true,
      profileDirPath: join(tmpdir(), `tdmcp-prof-test-${Date.now()}`),
      profileDirRepair: () => {
        throw new Error("permission denied");
      },
    });
    expect(r.report.repairs).toContainEqual(
      expect.objectContaining({ id: "profile_dir", status: "failed" }),
    );
    expect(r.report.fixes?.some((f) => f.id === "profile_dir")).toBe(true);
  });

  it("does not create profile directory without --fix", async () => {
    server.use(llmModels("qwen2.5:3b"));
    const created: string[] = [];
    const profileDir = join(tmpdir(), `tdmcp-no-fix-profiles-${Date.now()}`);
    const r = await runDoctor({
      config: makeConfig(),
      makeCtx,
      profileDirPath: profileDir,
      profileDirRepair: (dir) => {
        created.push(dir);
      },
    });
    expect(created).toHaveLength(0);
    expect(r.report.repairs).toBeUndefined();
  });
});
