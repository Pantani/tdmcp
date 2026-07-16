import { describe, expect, it, vi } from "vitest";
import { LlmClient, LlmResponseTooLargeError } from "../../src/llm/client.js";
import {
  createLazyLlmClient,
  DEFAULT_LLM_BASE_URL,
  resolveLlmClient,
} from "../../src/llm/resolve.js";
import {
  clientSupportsSampling,
  DEFAULT_MAX_TOKENS,
  pickSystem,
  SamplingLlmClient,
  toMultimodal,
  toSamplingMessages,
} from "../../src/llm/samplingClient.js";
import type { TdmcpConfig } from "../../src/utils/config.js";

// The SDK's `Server.createMessage` is heavily overloaded; we duck-type it for tests
// and cast through `never` at the call sites (matches the `scriptedClient` pattern
// in tests/unit/llmAgent.test.ts).
type FakeCreateMessage = ReturnType<typeof vi.fn>;
interface FakeServer {
  createMessage: FakeCreateMessage;
  getClientCapabilities: () => { sampling?: Record<string, unknown> } | undefined;
}

function makeServer(opts: {
  capabilities?: { sampling?: Record<string, unknown> } | undefined;
  reply?: unknown;
  rejectWith?: Error;
}): FakeServer {
  const createMessage = vi.fn(async (_p: unknown, _o?: unknown) => {
    if (opts.rejectWith) throw opts.rejectWith;
    return opts.reply;
  });
  return {
    createMessage,
    getClientCapabilities: () => opts.capabilities,
  };
}

function baseConfig(over: Partial<TdmcpConfig> = {}): TdmcpConfig {
  return {
    tdHost: "127.0.0.1",
    tdPort: 9980,
    transport: "stdio",
    logLevel: "info",
    requestTimeoutMs: 30_000,
    httpPort: 0,
    events: "off",
    rawPython: "off",
    bridgeToken: undefined,
    llmBaseUrl: DEFAULT_LLM_BASE_URL,
    llmModel: "qwen2.5:3b",
    llmApiKey: undefined,
    chatPort: 4141,
    vaultPath: undefined,
    ...over,
  } as TdmcpConfig;
}

describe("SamplingLlmClient.complete", () => {
  it("forwards system/maxTokens/temperature and maps string content to TextContent", async () => {
    const server = makeServer({
      reply: {
        role: "assistant",
        content: { type: "text", text: "hi" },
        model: "claude-x",
        stopReason: "endTurn",
      },
    });
    const client = new SamplingLlmClient(server as never);
    const res = await client.complete([{ role: "user", content: "yo" }], {
      system: "S",
      maxTokens: 64,
      temperature: 0.2,
    });

    expect(res).toEqual({ text: "hi", model: "claude-x", stopReason: "endTurn" });
    expect(server.createMessage).toHaveBeenCalledTimes(1);
    const [params] = server.createMessage.mock.calls[0] as [Record<string, unknown>, unknown];
    expect(params.systemPrompt).toBe("S");
    expect(params.maxTokens).toBe(64);
    expect(params.temperature).toBe(0.2);
    expect(params.messages).toEqual([{ role: "user", content: { type: "text", text: "yo" } }]);
  });

  it("forwards signal and timeoutMs to createMessage request options", async () => {
    const server = makeServer({
      reply: { role: "assistant", content: { type: "text", text: "" } },
    });
    const client = new SamplingLlmClient(server as never);
    const ac = new AbortController();
    await client.complete([{ role: "user", content: "x" }], {
      signal: ac.signal,
      timeoutMs: 12_000,
    });
    const call = server.createMessage.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(call[1].signal).toBe(ac.signal);
    expect(call[1].timeout).toBe(12_000);
  });

  it("preserves multimodal image parts 1:1 in sampling messages", async () => {
    const server = makeServer({
      reply: { role: "assistant", content: { type: "text", text: "ok" } },
    });
    const client = new SamplingLlmClient(server as never);
    await client.complete([
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", data: "BASE64", mimeType: "image/png" },
        ],
      },
    ]);
    const [params] = server.createMessage.mock.calls[0] as [Record<string, unknown>, unknown];
    expect(params.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", data: "BASE64", mimeType: "image/png" },
        ],
      },
    ]);
  });

  it("returns empty text when reply is a non-text content block", async () => {
    const server = makeServer({
      reply: {
        role: "assistant",
        content: { type: "image", data: "AAA", mimeType: "image/png" },
        model: "m",
      },
    });
    const client = new SamplingLlmClient(server as never);
    const res = await client.complete([{ role: "user", content: "x" }]);
    expect(res.text).toBe("");
    expect(res.model).toBe("m");
  });

  it("applies DEFAULT_MAX_TOKENS when maxTokens omitted", async () => {
    const server = makeServer({
      reply: { role: "assistant", content: { type: "text", text: "" } },
    });
    const client = new SamplingLlmClient(server as never);
    await client.complete([{ role: "user", content: "x" }]);
    const [params] = server.createMessage.mock.calls[0] as [Record<string, unknown>, unknown];
    expect(params.maxTokens).toBe(DEFAULT_MAX_TOKENS);
  });

  it("propagates errors from createMessage (degradation is the consumer's job)", async () => {
    const server = makeServer({ rejectWith: new Error("sampling declined") });
    const client = new SamplingLlmClient(server as never);
    await expect(client.complete([{ role: "user", content: "x" }])).rejects.toThrow(
      /sampling declined/,
    );
  });

  it("accepts sampled UTF-8 text exactly at maxResponseBytes", async () => {
    const text = "olá";
    const server = makeServer({
      reply: { role: "assistant", content: { type: "text", text } },
    });

    const result = await new SamplingLlmClient(server as never).complete(
      [{ role: "user", content: "x" }],
      { maxResponseBytes: Buffer.byteLength(text, "utf8") },
    );

    expect(result.text).toBe(text);
  });

  it("returns the typed oversized error after an already-materialized sampling response", async () => {
    const text = "olá";
    const server = makeServer({
      reply: { role: "assistant", content: { type: "text", text } },
    });

    const pending = new SamplingLlmClient(server as never).complete(
      [{ role: "user", content: "x" }],
      { maxResponseBytes: Buffer.byteLength(text, "utf8") - 1 },
    );

    await expect(pending).rejects.toBeInstanceOf(LlmResponseTooLargeError);
    await expect(pending).rejects.toMatchObject({ code: "LLM_RESPONSE_TOO_LARGE" });
  });
});

describe("clientSupportsSampling", () => {
  it("is true when capabilities include `sampling`", () => {
    expect(clientSupportsSampling({ getClientCapabilities: () => ({ sampling: {} }) })).toBe(true);
  });
  it("is false for empty / missing capabilities", () => {
    expect(clientSupportsSampling({ getClientCapabilities: () => ({}) })).toBe(false);
    expect(clientSupportsSampling({ getClientCapabilities: () => undefined })).toBe(false);
  });
});

describe("pure helpers", () => {
  it("pickSystem prefers override, else first system message text", () => {
    expect(pickSystem([{ role: "system", content: "S1" }], undefined)).toBe("S1");
    expect(pickSystem([{ role: "system", content: "S1" }], "OV")).toBe("OV");
    expect(
      pickSystem(
        [
          {
            role: "system",
            content: [
              { type: "text", text: "A" },
              { type: "text", text: "B" },
            ],
          },
        ],
        undefined,
      ),
    ).toBe("A\nB");
    expect(pickSystem([{ role: "user", content: "hi" }], undefined)).toBeUndefined();
  });

  it("toSamplingMessages drops system turns and wraps string content as TextContent", () => {
    expect(
      toSamplingMessages([
        { role: "system", content: "ignored" },
        { role: "user", content: "hi" },
        { role: "assistant", content: "there" },
      ]),
    ).toEqual([
      { role: "user", content: { type: "text", text: "hi" } },
      { role: "assistant", content: { type: "text", text: "there" } },
    ]);
  });

  it("toMultimodal drops `tool` turns and coerces null content to ''", () => {
    expect(
      toMultimodal([
        { role: "user", content: "x" },
        { role: "tool", content: "tool-output", tool_call_id: "c1" },
        { role: "assistant", content: null },
      ]),
    ).toEqual([
      { role: "user", content: "x" },
      { role: "assistant", content: "" },
    ]);
  });
});

describe("chatStream shim", () => {
  it("emits the full text once via onToken and returns an assistant message", async () => {
    const server = makeServer({
      reply: { role: "assistant", content: { type: "text", text: "all of it" } },
    });
    const client = new SamplingLlmClient(server as never);
    const tokens: string[] = [];
    const out = await client.chatStream([{ role: "user", content: "go" }], [], {
      onToken: (t) => tokens.push(t),
    });
    expect(tokens).toEqual(["all of it"]);
    expect(out).toEqual({ role: "assistant", content: "all of it" });
    expect(out.tool_calls).toBeUndefined();
  });

  it("returns content:null when sampling reply is empty (no token emitted)", async () => {
    const server = makeServer({
      reply: { role: "assistant", content: { type: "text", text: "" } },
    });
    const client = new SamplingLlmClient(server as never);
    const tokens: string[] = [];
    const out = await client.chatStream([{ role: "user", content: "go" }], [], {
      onToken: (t) => tokens.push(t),
    });
    expect(tokens).toEqual([]);
    expect(out).toEqual({ role: "assistant", content: null });
  });
});

describe("resolveLlmClient routing", () => {
  it("default config + sampling-capable client → SamplingLlmClient", () => {
    const server = makeServer({
      capabilities: { sampling: {} },
      reply: { role: "assistant", content: { type: "text", text: "" } },
    });
    const c = resolveLlmClient(baseConfig(), server as never);
    expect(c).toBeInstanceOf(SamplingLlmClient);
  });

  it("default config + client without sampling → LlmClient", () => {
    const server = makeServer({ capabilities: {} });
    const c = resolveLlmClient(baseConfig(), server as never);
    expect(c).toBeInstanceOf(LlmClient);
  });

  it("explicit non-default llmBaseUrl wins over sampling capability", () => {
    const server = makeServer({ capabilities: { sampling: {} } });
    const c = resolveLlmClient(
      baseConfig({ llmBaseUrl: "http://localhost:1234/v1" }),
      server as never,
    );
    expect(c).toBeInstanceOf(LlmClient);
  });

  it("setting an API key counts as explicit local config", () => {
    const server = makeServer({ capabilities: { sampling: {} } });
    const c = resolveLlmClient(baseConfig({ llmApiKey: "sk-test" }), server as never);
    expect(c).toBeInstanceOf(LlmClient);
  });

  it("no server (CLI) → LlmClient", () => {
    const c = resolveLlmClient(baseConfig(), undefined);
    expect(c).toBeInstanceOf(LlmClient);
  });
});

describe("createLazyLlmClient", () => {
  it("does not call getClientCapabilities until first use (defers past initialize)", () => {
    const capSpy = vi.fn(() => ({ sampling: {} }));
    const server = {
      createMessage: vi.fn(),
      getClientCapabilities: capSpy,
    };
    const lazy = createLazyLlmClient(baseConfig(), server as never);
    expect(capSpy).not.toHaveBeenCalled();
    // sanity: lazy wrapper exposes the LlmClientLike surface
    expect(typeof lazy.complete).toBe("function");
    expect(typeof lazy.chatStream).toBe("function");
  });

  it("picks SamplingLlmClient on first call when capabilities arrive post-initialize", async () => {
    let caps: { sampling?: Record<string, unknown> } | undefined;
    const server = {
      createMessage: vi.fn(async () => ({
        role: "assistant",
        content: { type: "text", text: "hi" },
      })),
      getClientCapabilities: () => caps,
    };
    const lazy = createLazyLlmClient(baseConfig(), server as never);
    // simulate the MCP initialize handshake completing
    caps = { sampling: {} };
    const out = await lazy.complete([{ role: "user", content: "ping" }]);
    expect(out.text).toBe("hi");
    expect(server.createMessage).toHaveBeenCalledOnce();
  });

  it("caches the resolved backend across calls (no re-probe)", async () => {
    let probes = 0;
    const server = {
      createMessage: vi.fn(async () => ({
        role: "assistant",
        content: { type: "text", text: "" },
      })),
      getClientCapabilities: () => {
        probes++;
        return { sampling: {} };
      },
    };
    const lazy = createLazyLlmClient(baseConfig(), server as never);
    await lazy.complete([{ role: "user", content: "a" }]);
    await lazy.complete([{ role: "user", content: "b" }]);
    expect(probes).toBe(1);
  });
});
