import { mkdtempSync, rmSync } from "node:fs";
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

/** Build a config from defaults, overriding only what a test cares about. */
function makeConfig(overrides: Partial<TdmcpConfig> = {}): TdmcpConfig {
  return { ...loadConfig({}), llmBaseUrl: LLM_BASE, ...overrides };
}

/** A ToolContext whose client talks to the msw-mocked TD bridge. */
function makeCtx(): ToolContext {
  return {
    client: new TouchDesignerClient({ baseUrl: TD_BASE, timeoutMs: 2000 }),
    knowledge: new KnowledgeBase(),
    recipes: new RecipeLibrary(),
    logger: silentLogger,
  };
}

/** msw handler for an Ollama-style OpenAI `/models` listing. */
function llmModels(...ids: string[]) {
  return http.get(`${LLM_BASE}/models`, () =>
    HttpResponse.json({ data: ids.map((id) => ({ id })) }),
  );
}

describe("tdmcp doctor", () => {
  it("passes everything when the bridge + LLM are healthy and the vault exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tdmcp-vault-"));
    try {
      server.use(llmModels("qwen2.5:3b"));
      const r = await runDoctor({
        config: makeConfig({ vaultPath: dir, llmModel: "qwen2.5:3b" }),
        makeCtx,
      });
      expect(r.code).toBe(0);
      expect(r.report.ok).toBe(true);
      const byId = Object.fromEntries(r.report.checks.map((c) => [c.id, c]));
      expect(byId.bridge?.status).toBe("pass");
      expect(byId.config?.status).toBe("pass");
      expect(byId.llm?.status).toBe("pass");
      expect(byId.vault?.status).toBe("pass");
      expect(r.stdout).toContain("TouchDesigner bridge");
      expect(r.stdout).toContain("All good");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports the resolved TD/LLM config in the config check and structured report", async () => {
    server.use(llmModels("qwen2.5:3b"));
    const r = await runDoctor({ config: makeConfig(), makeCtx });
    expect(r.report.config.tdBaseUrl).toBe(TD_BASE);
    expect(r.report.config.llmBaseUrl).toBe(LLM_BASE);
    expect(r.report.config.llmModel).toBe("qwen2.5:3b");
    const config = r.report.checks.find((c) => c.id === "config");
    expect(config?.detail).toContain(TD_BASE);
    expect(config?.detail).toContain(LLM_BASE);
  });

  it("fails (exit 1) and flags the bridge when TouchDesigner is unreachable", async () => {
    server.use(offlineInfoHandler);
    server.use(llmModels("qwen2.5:3b"));
    const r = await runDoctor({ config: makeConfig(), makeCtx });
    expect(r.code).toBe(1);
    expect(r.report.ok).toBe(false);
    const bridge = r.report.checks.find((c) => c.id === "bridge");
    expect(bridge?.status).toBe("fail");
    expect(bridge?.critical).toBe(true);
    expect(r.stdout).toContain("not reachable");
    expect(r.stderr).toContain("not ready");
  });

  it("warns (but does not fail) when the LLM endpoint is unreachable", async () => {
    server.use(http.get(`${LLM_BASE}/models`, () => HttpResponse.error()));
    const r = await runDoctor({ config: makeConfig(), makeCtx });
    expect(r.code).toBe(0);
    expect(r.report.ok).toBe(true);
    const llm = r.report.checks.find((c) => c.id === "llm");
    expect(llm?.status).toBe("warn");
    expect(llm?.critical).toBe(false);
    expect(r.stdout).toContain("tdmcp chat");
  });

  it("warns when the LLM endpoint is up but the model is not pulled", async () => {
    server.use(llmModels("some-other-model"));
    const r = await runDoctor({ config: makeConfig({ llmModel: "qwen2.5:3b" }), makeCtx });
    expect(r.code).toBe(0);
    const llm = r.report.checks.find((c) => c.id === "llm");
    expect(llm?.status).toBe("warn");
    expect(llm?.detail).toContain("ollama pull qwen2.5:3b");
  });

  it("treats an unset vault as a pass-with-note (not a failure)", async () => {
    server.use(llmModels("qwen2.5:3b"));
    const r = await runDoctor({ config: makeConfig({ vaultPath: undefined }), makeCtx });
    expect(r.code).toBe(0);
    const vault = r.report.checks.find((c) => c.id === "vault");
    expect(vault?.status).toBe("pass");
    expect(vault?.detail).toContain("not configured");
  });

  it("warns when a configured vault path is missing (via injected probe, no fs)", async () => {
    server.use(llmModels("qwen2.5:3b"));
    const r = await runDoctor({
      config: makeConfig({ vaultPath: "/nope/does-not-exist" }),
      makeCtx,
      vaultProbe: () => ({ exists: false, isDir: false }),
    });
    expect(r.code).toBe(0); // optional feature → warn, not a hard failure
    const vault = r.report.checks.find((c) => c.id === "vault");
    expect(vault?.status).toBe("warn");
    expect(vault?.detail).toContain("does not exist");
  });

  it("uses an injected LLM client so no network call is needed", async () => {
    server.use(llmModels("qwen2.5:3b")); // present but should be unused
    const r = await runDoctor({
      config: makeConfig(),
      makeCtx,
      makeLlmClient: () => ({
        health: async () => ({ ok: true, modelReady: true, detail: "model 'stub' is ready" }),
      }),
    });
    expect(r.code).toBe(0);
    const llm = r.report.checks.find((c) => c.id === "llm");
    expect(llm?.status).toBe("pass");
    expect(llm?.detail).toContain("model 'stub' is ready");
  });

  it("produces a human-readable report with a status icon per check", async () => {
    server.use(llmModels("qwen2.5:3b"));
    const r = await runDoctor({ config: makeConfig(), makeCtx });
    expect(r.stdout).toContain("tdmcp doctor");
    // one line per check (bridge, config, tools, llm, vault)
    expect(r.report.checks).toHaveLength(5);
    for (const c of r.report.checks) expect(r.stdout).toContain(c.title);
  });

  it("reports a Tools check that flags a restricted surface", async () => {
    server.use(llmModels("qwen2.5:3b"));
    const r = await runDoctor({
      config: makeConfig({ rawPython: "off", toolProfile: "safe" }),
      makeCtx,
    });
    const tools = r.report.checks.find((c) => c.id === "tools");
    expect(tools?.detail).toContain("restricted");
    expect(tools?.critical).toBe(false);
  });

  it("--fix appends suggested remediation commands for non-passing checks", async () => {
    // No LLM mock → llm check warns → a fix suggestion appears.
    const r = await runDoctor({ config: makeConfig(), makeCtx, fix: true });
    expect(r.report.fixes?.length).toBeTruthy();
    expect(r.stdout).toContain("Suggested fixes");
    expect(r.report.fixes?.some((f) => f.id === "llm")).toBe(true);
  });
});
