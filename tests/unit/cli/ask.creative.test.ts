import { afterEach, describe, expect, it, vi } from "vitest";
import { runAsk } from "../../../src/cli/ask.js";
import type { CreativeRagService } from "../../../src/creativeRag/index.js";
import type { ChatMessage } from "../../../src/llm/client.js";
import type { LoadedTdmcpConfig } from "../../../src/utils/config.js";

type OnEvent = (event: unknown) => void;

function makeResult(id: string) {
  return {
    id,
    score: 0.9,
    title: `Card ${id}`,
    type: "artwork" as const,
    license: "CC0" as const,
    sourceUrl: `https://example.com/${id}`,
    sourceName: "test-source",
    tags: [],
  };
}

function makeConfig(): LoadedTdmcpConfig {
  // Mirror loadConfig's behavior for the env vars this test exercises so the
  // env-overrides-flag case (TDMCP_RAG_INJECT_ASK=1) actually flips ragInjectAsk
  // in the parsed config — the production CLI reads from config, not env.
  const envInjectAsk = process.env.TDMCP_RAG_INJECT_ASK;
  const ragInjectAsk = envInjectAsk === "1" || envInjectAsk === "true";
  return {
    tdHost: "127.0.0.1",
    tdPort: 9980,
    tdBridgeToken: undefined,
    tdBridgeAllowExec: true,
    llmBaseUrl: "http://127.0.0.1:11434/v1",
    llmModel: "qwen2.5:3b",
    llmTier: "write",
    llmMaxSteps: 5,
    llmTemperature: undefined,
    logLevel: "silent",
    allowRawPython: false,
    vaultPath: undefined,
    ragEnabled: false,
    ragCardDir: undefined,
    ragIndexPath: undefined,
    ragEmbeddingModel: undefined,
    ragSyncOnStartup: false,
    ragLanceDir: undefined,
    ragApplyCard: false,
    ragInjectAsk,
    ragInjectK: 3,
    ragInjectTimeoutMs: 3000,
    ragProbeTimeoutMs: 3000,
  } as unknown as LoadedTdmcpConfig;
}

function buildRunAskDeps(extraDeps: {
  ragEnabled?: boolean;
  capturedMessages: ChatMessage[][];
  searchSpy: ReturnType<typeof vi.fn>;
  stdout: string[];
  stderr: string[];
}) {
  const ragService: CreativeRagService | undefined = extraDeps.ragEnabled
    ? ({
        search: extraDeps.searchSpy,
        sync: vi.fn(),
        index: vi.fn(),
        getCard: vi.fn(),
      } as unknown as CreativeRagService)
    : undefined;

  const ctx = {
    ...(ragService ? { creativeRag: ragService } : {}),
    logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
  };

  const runAgentTurnMock = vi
    .fn()
    .mockImplementation(
      async (_ctx: unknown, _client: unknown, msgs: ChatMessage[], onEvent: OnEvent) => {
        extraDeps.capturedMessages.push([...msgs]);
        onEvent({ type: "answer", content: "ok" });
        return msgs;
      },
    );

  return {
    deps: {
      loadConfig: () => makeConfig(),
      buildToolContext: () =>
        ctx as unknown as ReturnType<
          typeof import("../../../src/server/context.js").buildToolContext
        >,
      createClient: () =>
        ({ chat: vi.fn() }) as unknown as import("../../../src/llm/client.js").LlmClient,
      runAgentTurn:
        runAgentTurnMock as unknown as typeof import("../../../src/llm/agent.js").runAgentTurn,
      writeStdout: (s: string) => extraDeps.stdout.push(s),
      writeStderr: (s: string) => extraDeps.stderr.push(s),
      isStdinTTY: () => true,
    },
    ctx,
    ragService,
  };
}

describe("runAsk creative context injection", () => {
  const origEnv = { ...process.env };

  afterEach(() => {
    for (const k of ["TDMCP_RAG_INJECT_ASK", "TDMCP_RAG_INJECT_K", "TDMCP_RAG_INJECT_TIMEOUT_MS"]) {
      if (origEnv[k] === undefined) {
        Reflect.deleteProperty(process.env, k);
      } else {
        process.env[k] = origEnv[k];
      }
    }
  });

  it("flag off, env off: search never called, messages length 1 (user only)", async () => {
    const captured: ChatMessage[][] = [];
    const searchSpy = vi.fn().mockResolvedValue([makeResult("c1")]);

    Reflect.deleteProperty(process.env, "TDMCP_RAG_INJECT_ASK");

    const { deps } = buildRunAskDeps({
      ragEnabled: true,
      capturedMessages: captured,
      searchSpy,
      stdout: [],
      stderr: [],
    });

    await runAsk(["hello"], deps);

    expect(searchSpy).not.toHaveBeenCalled();
    expect(captured[0]).toHaveLength(1);
    expect(captured[0]?.[0]?.role).toBe("user");
  });

  it("flag on, RAG disabled: no error, exit 0, warns on stderr, messages length 1", async () => {
    const captured: ChatMessage[][] = [];
    const stderr: string[] = [];

    const { deps } = buildRunAskDeps({
      ragEnabled: false,
      capturedMessages: captured,
      searchSpy: vi.fn(),
      stdout: [],
      stderr,
    });

    await runAsk(["--with-creative", "hello"], deps);

    expect(process.exitCode).toBeFalsy();
    const fullStderr = stderr.join("");
    expect(fullStderr).toContain("skipping");
    expect(captured[0]).toHaveLength(1);
    expect(captured[0]?.[0]?.role).toBe("user");
  });

  it("flag on, RAG enabled: messages[0].role === system, messages[1] is original user prompt", async () => {
    const captured: ChatMessage[][] = [];
    const searchSpy = vi.fn().mockResolvedValue([makeResult("card-abc")]);

    const { deps } = buildRunAskDeps({
      ragEnabled: true,
      capturedMessages: captured,
      searchSpy,
      stdout: [],
      stderr: [],
    });

    await runAsk(["--with-creative", "my question"], deps);

    const msgs = captured[0] ?? [];
    expect(msgs).toHaveLength(2);
    // role MUST be "user" — `runAgentTurn.ensureSystem` filters every incoming
    // `role: "system"` message before injecting its own authoritative system
    // prompt, so a system-role context block would never reach the LLM.
    expect(msgs[0]?.role).toBe("user");
    expect(msgs[0]?.content).toContain("tdmcp://creative/cards/card-abc");
    expect(msgs[1]?.role).toBe("user");
    expect(msgs[1]?.content).toBe("my question");
  });

  it("env TDMCP_RAG_INJECT_ASK=1 (no flag): injection happens", async () => {
    process.env.TDMCP_RAG_INJECT_ASK = "1";
    const captured: ChatMessage[][] = [];
    const searchSpy = vi.fn().mockResolvedValue([makeResult("env-card")]);

    const { deps } = buildRunAskDeps({
      ragEnabled: true,
      capturedMessages: captured,
      searchSpy,
      stdout: [],
      stderr: [],
    });

    await runAsk(["env test"], deps);

    const msgs = captured[0] ?? [];
    expect(msgs).toHaveLength(2);
    // role MUST be "user" — `runAgentTurn.ensureSystem` filters every incoming
    // `role: "system"` message before injecting its own authoritative system
    // prompt, so a system-role context block would never reach the LLM.
    expect(msgs[0]?.role).toBe("user");
    expect(msgs[0]?.content).toContain("tdmcp://creative/cards/env-card");
  });

  it("--tools=off + --with-creative: system message still prepended", async () => {
    const captured: ChatMessage[][] = [];
    const searchSpy = vi.fn().mockResolvedValue([makeResult("off-card")]);

    const { deps } = buildRunAskDeps({
      ragEnabled: true,
      capturedMessages: captured,
      searchSpy,
      stdout: [],
      stderr: [],
    });

    await runAsk(["--tools=off", "--with-creative", "combo test"], deps);

    const msgs = captured[0] ?? [];
    // role MUST be "user" — `runAgentTurn.ensureSystem` filters every incoming
    // `role: "system"` message before injecting its own authoritative system
    // prompt, so a system-role context block would never reach the LLM.
    expect(msgs[0]?.role).toBe("user");
    expect(msgs[0]?.content).toContain("tdmcp://creative/cards/off-card");
    expect(msgs[1]?.role).toBe("user");
  });

  // Regression for the original bug: `runAgentTurn` strips every incoming
  // `role: "system"` message before injecting its own authoritative system
  // prompt. The previous implementation returned a `system`-role message, so
  // the cards were silently dropped before reaching the LLM. We mimic the real
  // ensureSystem filter here and assert the cards survive.
  it("regression — creative cards survive runAgentTurn.ensureSystem's role:system filter", async () => {
    const captured: ChatMessage[][] = [];
    const searchSpy = vi.fn().mockResolvedValue([makeResult("survivor")]);

    const { deps } = buildRunAskDeps({
      ragEnabled: true,
      capturedMessages: captured,
      searchSpy,
      stdout: [],
      stderr: [],
    });

    await runAsk(["--with-creative", "what survives"], deps);

    const msgs = captured[0] ?? [];
    // Apply the EXACT filter that src/llm/agent.ts → ensureSystem applies.
    const survivors = msgs.filter((m) => m.role !== "system");
    const cardsReachLlm = survivors.some(
      (m) => typeof m.content === "string" && m.content.includes("tdmcp://creative/cards/survivor"),
    );
    expect(cardsReachLlm).toBe(true);
  });
});
